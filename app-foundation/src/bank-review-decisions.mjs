// Owner explanations are a separate preview layer. They never overwrite bank
// facts, create a receiving transaction, assign a trip or post to the ledger.
export function applyReviewDecisions(preview,document){
 const invalid=message=>{throw Error('BANK_REVIEW_DECISION: '+message);};
 if(preview.mode!=='preview_only'||preview.postingEnabled!==false||document?.schemaVersion!==1||document.scope!=='preview_only'||!document.confirmedBy||!document.recordedAt||!Array.isArray(document.decisions))invalid('Нужен предпросмотр и явные уточнения владельца');
 const next=structuredClone(preview),ids=new Set();
 for(const decision of document.decisions){
  if(!decision.id||ids.has(decision.id)||!decision.text)invalid('Повтор или неполное основание уточнения');
  ids.add(decision.id);
  const target=decision.target,keys=['fingerprint','documentKey','account','date','documentNumber','amount'];
  if(!target||keys.some(k=>typeof target[k]!=='string'||!target[k]))invalid('Нужна точная идентичность операции');
  const candidates=next.operations.filter(o=>keys.every(k=>o[k]===target[k]));
  if(candidates.length!==1||candidates[0].identityReview)invalid('Операция изменилась, неоднозначна или отсутствует; уточнение не применено');
  const op=candidates[0],history=op.ownerDecisions??[];
  const previous=history.find(h=>h.decision.id===decision.id);
  if(previous){if(JSON.stringify(previous.decision)!==JSON.stringify(decision))invalid('Нельзя изменить прежнее решение под тем же ID');continue;}
  if(history.length)invalid('Для изменения принятого уточнения нужна отдельная версия');
  op.previousReview={state:op.state,findings:op.findings,questions:op.questions};
  if(decision.action==='internal_transfer'){
   if(op.direction!=='outflow'||!op.recipient?.account)invalid('Не подтверждён исходящий перевод на известный банковский счёт');
   const intercompany=op.sender?.taxId!==op.recipient?.taxId;
   op.state='classified';
   op.classification={kind:'internal_transfer',scope:'management',intercompany,profitImpact:'none',confirmedBy:document.confirmedBy};
   op.transferReconciliation={status:'awaiting_receiving_statement',destinationAccount:op.recipient.account,receivingOperationId:null};
   op.questions=[];
   op.findings=[`${document.confirmedBy} подтвердил: перевод между счетами${intercompany?' разных компаний':''}. Не относить к выручке, постоянным расходам или бонусной базе.`,
    'Классификация принята в предпросмотре. Принимающая сторона ещё не сверена по выписке; встречная операция не создана.'];
   if(intercompany)op.findings.push('Это управленческая классификация. Исходное назначение банка о возврате сохранено без изменения; бухгалтерское основание этим не переписывается.');
  }else if(decision.action==='set_category'){
   if(typeof decision.category!=='string'||!decision.category.trim()||decision.category.length>120)invalid('Нужна категория');
   op.category=decision.category;
   op.state='needs_information';
   op.findings=[`${document.confirmedBy} подтвердил категорию «${decision.category}».`,
    'Дата сделки и проект ещё не указаны. Дата счёта и дата банковского платежа не подставлены вместо даты сделки.'];
   op.questions=['Осталось указать дату сделки и проект либо подтвердить учёт без проекта.'];
  }else if(decision.action==='defer'){
   op.state='deferred';op.deferredQuestions=op.questions;op.questions=[];
   op.findings=[`Отложено по просьбе владельца: «${decision.text}». Сейчас уточнений не запрашиваем.`,
    'Строка остаётся в выписке и сверке её оборотов. К рейсу, проекту и бонусам она не привязана; в рабочий учёт не проведена.'];
  }else invalid('Неизвестный тип уточнения');
  op.ownerDecisions=[...history,{confirmedBy:document.confirmedBy,recordedAt:document.recordedAt,decision:structuredClone(decision)}];
 }
 next.ownerClarifiedAt=document.recordedAt;
 const count=state=>next.operations.filter(o=>o.state===state).length;
 next.counts={total:next.operations.length,needsInformation:count('needs_information'),alreadyRecorded:count('already_recorded'),noBusinessQuestion:count('no_business_question'),classified:count('classified'),deferred:count('deferred')};
 if(Object.entries(next.counts).filter(([k])=>k!=='total').reduce((s,[,v])=>s+v,0)!==next.counts.total)invalid('Есть операции с неизвестным состоянием');
 return next;
}
