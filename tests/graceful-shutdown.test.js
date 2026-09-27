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
