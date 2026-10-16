'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {installGracefulShutdown}=require('../src/graceful-shutdown');

test('graceful shutdown marks not-ready, closes HTTP, then closes PostgreSQL',async()=>{
  const processLike=new EventEmitter();
  processLike.exitCode=undefined;
  const events=[];
  const readinessProbe={markDraining(){events.push('draining');}};
  const server={
    close(callback){events.push('server-close'); callback();},
    closeIdleConnections(){events.push('idle-close');},
    closeAllConnections(){events.push('force-close');},
  };
  const pool={async end(){events.push('pool-end');}};
  const timer={unref(){events.push('timer-unref');}};
  const controller=installGracefulShutdown({
    server,pool,readinessProbe,processLike,timeoutMs:5000,
    setTimeoutImpl(){return timer;},
    clearTimeoutImpl(value){assert.equal(value,timer); events.push('timer-clear');},
  });
  await controller.shutdown();
  assert.deepEqual(events,[
    'draining','timer-unref','server-close','idle-close','pool-end','timer-clear',
  ]);
  assert.equal(processLike.exitCode,0);

  await controller.shutdown();
  assert.equal(events.length,6,'shutdown must be idempotent');
});

test('graceful shutdown installs SIGTERM and SIGINT handlers',()=>{
  const processLike=new EventEmitter();
  const server={close(callback){callback();}};
  installGracefulShutdown({
    server,processLike,timeoutMs:1000,
    setTimeoutImpl(){return {unref(){}};},
    clearTimeoutImpl(){},
  });
  assert.equal(processLike.listenerCount('SIGTERM'),1);
  assert.equal(processLike.listenerCount('SIGINT'),1);
});


test('shutdown records HTTP close callback errors and still closes PostgreSQL',async()=>{
  const processLike=new EventEmitter();
  const events=[];
  const server={
    close(callback){events.push('http-close');callback(new Error('ERR_SERVER_NOT_RUNNING'));},
    closeIdleConnections(){events.push('idle-close');},
  };
  const pool={async end(){events.push('postgres-end');}};
  const controller=installGracefulShutdown({
    server,pool,processLike,timeoutMs:5000,
    setTimeoutImpl(){return {unref(){}};},
    clearTimeoutImpl(){events.push('timer-clear');},
  });

  await controller.shutdown();
  assert.equal(processLike.exitCode,1,'failed HTTP close must not exit successfully');
  assert.deepEqual(events,['http-close','idle-close','postgres-end','timer-clear']);
});

test('shutdown catches a synchronous HTTP close exception but still releases PostgreSQL',async()=>{
  const processLike=new EventEmitter();
  const events=[];
  const controller=installGracefulShutdown({
    server:{
      close(){events.push('http-throws');throw new Error('synthetic HTTP failure');},
      closeIdleConnections(){events.push('must-not-run');},
    },
    pool:{async end(){events.push('postgres-end');}},
    processLike,timeoutMs:5000,
    setTimeoutImpl(){return {unref(){}};},
    clearTimeoutImpl(){events.push('timer-clear');},
  });
  await controller.shutdown();
  assert.equal(processLike.exitCode,1);
  assert.deepEqual(events,['http-throws','postgres-end','timer-clear']);
});

test('shutdown reports a PostgreSQL close failure after successful HTTP close',async()=>{
  const processLike=new EventEmitter();
  const events=[];
  const controller=installGracefulShutdown({
    server:{
      close(callback){events.push('http-close');callback();},
      closeIdleConnections(){events.push('idle-close');},
    },
    pool:{async end(){events.push('postgres-throws');throw new Error('synthetic database detail');}},
    processLike,timeoutMs:5000,
    setTimeoutImpl(){return {unref(){}};},
    clearTimeoutImpl(){events.push('timer-clear');},
  });
  await controller.shutdown();
  assert.equal(processLike.exitCode,1);
  assert.deepEqual(events,['http-close','idle-close','postgres-throws','timer-clear']);
});


test('concurrent shutdown callers wait for the same HTTP and PostgreSQL cleanup',async()=>{
  const processLike=new EventEmitter();
  let finishHttp;
  let finishDb;
  let httpCalls=0;
  let dbCalls=0;
  let timerClears=0;
  const controller=installGracefulShutdown({
    server:{
      close(callback){httpCalls++;finishHttp=callback;},
      closeIdleConnections(){},
    },
    pool:{end(){dbCalls++;return new Promise(resolve=>{finishDb=resolve;});}},
    processLike,timeoutMs:5000,
    setTimeoutImpl(){return {unref(){}};},
    clearTimeoutImpl(){timerClears++;},
  });
  const first=controller.shutdown();
  const second=controller.shutdown();
  assert.strictEqual(second,first,'repeat shutdown must return the active promise');
  assert.equal(httpCalls,1);

  let completed=false;
  second.then(()=>{completed=true;});
  await Promise.resolve();
  assert.equal(completed,false);

  finishHttp();
  // The HTTP close resolves before the database cleanup begins.
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(dbCalls,1);
  assert.equal(completed,false,'shutdown must wait for PostgreSQL as well');

  finishDb();
  await Promise.all([first,second]);
  assert.equal(completed,true);
  assert.equal(timerClears,1);
  assert.equal(processLike.exitCode,0);
});
