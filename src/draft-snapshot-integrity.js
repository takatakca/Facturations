'use strict';

const crypto=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {previewDraft}=require('./draft-preview');

const HASH=/^[a-f0-9]{64}$/;

function computeDraftPreviewHash(preview){
  return crypto.createHash('sha256')
    .update(JSON.stringify(preview))
    .digest('hex');
}

function inputFromStoredSnapshot(snapshot){
  if(!snapshot || typeof snapshot!=='object' || Array.isArray(snapshot)){
    throw new TypeError('Stored draft snapshot required');
  }
  return {
    currency:snapshot.currency,
    customer:{
      name:snapshot.customer?.name,
      email:snapshot.customer?.email,
      address:snapshot.customer?.address,
    },
    invoiceDate:snapshot.invoiceDate,
    dueDate:snapshot.dueDate,
    notes:snapshot.notes,
    lines:Array.isArray(snapshot.lines)
      ? snapshot.lines.map(line=>({
          description:line?.description,
          quantity:line?.quantity,
          unitPriceCents:line?.unitPriceCents,
          discountCents:line?.discountCents,
          taxable:line?.taxable,
        }))
      : snapshot.lines,
    taxes:Array.isArray(snapshot.taxes)
      ? snapshot.taxes.map(tax=>({
          code:tax?.code,
          label:tax?.label,
          rateMilliPercent:tax?.rateMilliPercent,
        }))
      : snapshot.taxes,
  };
}

function verifyPersistedDraftSnapshot(snapshot,expectedHash){
  if(typeof expectedHash!=='string' || !HASH.test(expectedHash)) return false;
  try{
    const preview=previewDraft(inputFromStoredSnapshot(snapshot));
    const expectedSnapshot={...preview,status:'DRAFT',persisted:true};
    return computeDraftPreviewHash(preview)===expectedHash &&
      isDeepStrictEqual(snapshot,expectedSnapshot);
  }catch{
    return false;
  }
}

module.exports={computeDraftPreviewHash,verifyPersistedDraftSnapshot};
