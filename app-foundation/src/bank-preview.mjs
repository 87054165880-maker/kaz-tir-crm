import {createHash} from 'node:crypto';

// Read-only adapter for the two inspected Forte KZT examples. Not a posting engine.
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean=value=>String(value??'').trim();
const fail=message=>{throw new Error('BANK_PREVIEW: '+message);};
export function minor(value){
 const text=clean(value).replace(/[\s\u00a0\u202f]/g,'').replace(',','.');
 if(!/^-?\d+(?:\.\d{1,2})?$/.test(text))fail('Некорректная или отсутствующая сумма');
 const negative=text.startsWith('-'),[whole,frac='']=text.replace(/^-/, '').split('.');
 return (negative?-1n:1n)*(BigInt(whole)*100n+BigInt(frac.padEnd(2,'0')));
}
export function formatMoney(value,currency='KZT'){
 const n=BigInt(value),a=n<0n?-n:n,f=String(a%100n).padStart(2,'0');
 return `${n<0n?'−':''}${(a/100n).toLocaleString('ru-RU')}${f==='00'?'':','+f} ${currency==='KZT'?'₸':currency}`;
}
function party(block){return {name:clean(block).split('\n')[0],taxId:clean(block).match(/БИН:\s*(\d{12})/)?.[1]??null,account:clean(block).match(/ИИК:\s*(KZ[A-Z0-9]{18})/)?.[1]??null};}
function bankDate(value){
 const m=clean(value).match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
 if(!m)fail('Неизвестный формат даты');
 const date=`${m[3]}-${m[2]}-${m[1]}`;
 if(new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||+m[4]>23||+m[5]>59||+m[6]>59)fail('Неверная дата');
 return date; // Source local date: no invented timezone or settlement/deal date.
}
export function parseStatement(source){
 const v=source.values;
 if(source.sheet!=='report_acc_statement'||!Array.isArray(v)||v.length!==24||v.some(r=>!Array.isArray(r)||r.length!==9))fail('Нужен проверенный формат образца A1:I24');
 if(!/Номер документа/.test(v[15][2])||!/Дебет/.test(v[15][5])||!/Кредит/.test(v[15][6])||!/Обороты/.test(v[21][1])||!/Итого документов/.test(v[22][0])||!/Исходящий остаток/.test(v[23][0]))fail('Структура выписки изменилась');
 const account=clean(v[10][3]),currency=clean(v[12][3]),company=clean(v[3][3]),taxId=clean(v[9][3]);
 if(!/^KZ[A-Z0-9]{18}$/.test(account)||currency!=='KZT'||!/^\d{12}$/.test(taxId)||!company)fail('Реквизиты или валюта не поддержаны этим образцом');
 if(!/^[a-f0-9]{64}$/.test(source.sha256??''))fail('Нет контрольной суммы файла');
 const operations=v.slice(16,21).map((row,index)=>{
  const debit=minor(row[5]),credit=minor(row[6]);
  if(debit<0n||credit<0n||(debit>0n)===(credit>0n))fail('Нужно одно положительное направление');
  const date=bankDate(row[1]),documentNumber=clean(row[2]);
  if(!documentNumber||!clean(v[2][0]).includes(date.split('-').reverse().join('.')))fail('Номер документа или период не совпадает');
  const sender=party(row[3]),recipient=party(row[4]),direction=debit>0n?'outflow':'inflow';
  const ourParty=direction==='outflow'?sender:recipient;
  if(ourParty.account!==account||ourParty.taxId!==taxId)fail('Строка относится к другому счёту');
  const amount=(debit+credit).toString(),purpose=clean(row[7]),counterparty=direction==='outflow'?recipient:sender;
  const identity=[account,currency,date.slice(0,4),documentNumber];
  const fingerprint=hash([identity,date,clean(row[1]),direction,amount,sender,recipient,purpose,clean(row[8])]);
  return {account,currency,company,date,bankTimestamp:clean(row[1]),documentNumber,direction,amount,purpose,counterparty,sender,recipient,
   documentKey:hash(identity),fingerprint,source:{file:source.path.split('/').pop(),sha256:source.sha256,sheet:source.sheet,row:index+17},dealDate:null,project:null,responsible:null,tripId:null};
 });
 const debit=operations.filter(o=>o.direction==='outflow').reduce((s,o)=>s+BigInt(o.amount),0n),credit=operations.filter(o=>o.direction==='inflow').reduce((s,o)=>s+BigInt(o.amount),0n),opening=minor(v[14][3]),closing=minor(v[23][3]);
 if(debit!==minor(v[21][5])||credit!==minor(v[21][6])||operations.length!==Number(v[22][3])||opening+credit-debit!==closing)fail('Обороты, остатки или число документов не сошлись');
 return {company,account,currency,sha256:source.sha256,opening:opening.toString(),closing:closing.toString(),debit:debit.toString(),credit:credit.toString(),operations};
}
export function collectStatements(sources){
 const statements=[],seen=new Map(),repeatedFiles=[];
 const content=s=>hash({...s,operations:s.operations.map(({source,...o})=>o)});
 for(const source of sources){
  const statement=parseStatement(source),previous=seen.get(source.sha256);
  if(previous){if(content(previous)!==content(statement))fail('Один хэш связан с разным содержимым');repeatedFiles.push(source.path.split('/').pop());continue;}
  statements.push(statement);seen.set(source.sha256,statement);
 }
 const operations=statements.flatMap(s=>s.operations),groups=new Map();
 for(const op of operations){const group=groups.get(op.documentKey)??[];group.push(op);groups.set(op.documentKey,group);}
 for(const group of groups.values())if(group.length>1)for(const op of group)op.identityReview=group.every(v=>v.fingerprint===op.fingerprint)?'Возможное повторное включение операции; не объединено':'Один номер документа в этом счёте и году имеет разные реквизиты';
 return {statements,operations,repeatedFiles};
}

// This review is explicit analyst evidence for a fixed pair of samples, not
// an amount-only matcher or a reusable guess about the user's business rules.
export function buildSampleReview(sources,evidence){
 const batch=collectStatements(sources);
 if(batch.operations.length!==10||evidence.ranges?.trips?.range!=='trips!A2:AN3'||evidence.ranges?.accounts?.range!=='accounts!A1:D21'||evidence.ranges?.payments?.range!=='payments!A1:G70')fail('Нужны проверенные источники этого предпросмотра');
 const trips=evidence.ranges.trips.values;
 if(trips[0]?.[0]!=='TR9001'||trips[1]?.[0]!=='TR9002')fail('Исходные TR-ID изменились');
 if(trips[0][26]!=='58 и 59'||trips[1][26]!=='57 и 56'||minor(trips[0][14])!==12000000n||minor(trips[1][14])!==18000000n||minor(trips[0][27])!==5000000n||trips.some(t=>t[2]!=='ТОО "SYNTHETIC CLIENT A"'||t[31]!=='SYNTHETIC ACCOUNT B'))fail('Данные рейсов изменились; нужен новый разбор, прежние выводы не применять');
 const accounts=evidence.ranges.accounts.values.slice(1),payments=evidence.ranges.payments.values;
 const sum=trips.reduce((s,t)=>s+minor(t[14]),0n),prior=minor(trips[0][27]);
 const operations=batch.operations.map(op=>{
  const o={...op,state:'needs_information',title:op.counterparty.name,findings:[],questions:[]};
  const suffix=op.account.slice(-4),doc=op.documentNumber;
  if(/^Комиссия за операцию/.test(op.purpose)&&op.counterparty.taxId==='000000000099'){
   o.state='no_business_question';o.findings=['Предложение: «Постоянные расходы → Банковские комиссии», без проекта. Правило ещё не подтверждено; ничего не проведено.'];
  }else if(suffix==='2222'&&doc==='2201'){
   const matches=payments.map((r,i)=>({r,row:i+1})).filter(({r})=>r[0]===`PAY-20260915-0000002222-2201-expense-${op.amount}`&&r[1]===46280&&r[2]==='TR9001'&&minor(r[4])===BigInt(op.amount)&&r[5]==='carrier_payment');
   if(matches.length===1){o.state='already_recorded';o.tripId='TR9001';o.findings=[`Уже есть в payments!A${matches[0].row}:G${matches[0].row}. Дата, номер документа, счёт в ID, сумма и TR9001 совпали. Повторную запись не предлагать.`];}
   else{o.questions=['Проверить существующую оплату TR9001: ожидаемая запись payments не найдена однозначно.'];}
  }else if(suffix==='2222'&&doc==='2202'){
   if(BigInt(op.amount)!==30000700n||op.direction!=='inflow')fail('Общий платёж изменился; прежний разбор недействителен');
   o.title='SYNTHETIC CLIENT A — счета 56, 57, 58, 59';
   o.findings=[`Кандидаты по клиенту, счетам и счёту поступления: TR9001 (58, 59) — ${formatMoney(minor(trips[0][14]))}; TR9002 (56, 57) — ${formatMoney(minor(trips[1][14]))}.`,
    `Их общая выручка ${formatMoney(sum)}; поступление больше на ${formatMoney(BigInt(op.amount)-sum)}.`,
    `По TR9001 уже указано «Получено»: ${formatMoney(prior)}. Это исходный агрегат, а не подтверждённое отдельное банковское событие.`,
    `Оба рейса: менеджер ${trips[0][11]}, логист ${trips[0][12]}. Это кандидаты для привязки, не назначение финансового проекта.`];
   o.questions=['Нужны суммы по счетам 56–59 и основание расхождения 7 ₸.','Уточнить, что покрывают уже указанные 50 000 ₸: отдельный платёж, часть этого поступления или ошибка старого учёта.','После подтверждения разбивки перенести проект и дату сделки из подтверждённых рейсов/правил, не из даты банковского платежа.'];
   o.candidates=trips.map(t=>({trip:t[0],invoices:t[26],manager:t[11],logistician:t[12]}));
  }else if(suffix==='1111'&&(doc==='1103'||doc==='1104')){
   const invoice=doc==='1103'?'170':'166';
   o.findings=[`В назначении: счёт №${invoice} от 15.09.2026. Подтверждённый рейс не найден в проверенном trips!A1:AF1000.`];
   if(doc==='1104')o.findings.push('Номер 166 встречается у TR9003, но там другой счёт, мартовский рейс, клиент «нет» и уже полученные 12 000 ₸. Совпадения номера недостаточно.');
   o.questions=['Указать TR-ID либо подтвердить, что перевозку ещё нужно завести. Затем взять из неё проект, ответственного и дату сделки.'];
  }else if(suffix==='1111'&&doc==='1102'){
   o.findings=['Услуги по счёту №15 от 31.08.2026. Однозначного рейса не найдено в проверенном диапазоне.'];
   o.questions=['Что за услуги: расход рейса, машины или общий расход? Нужны категория, дата сделки и проект, если применим.'];
  }else if((suffix==='1111'&&doc==='1101')||(suffix==='2222'&&doc==='2204')){
   o.findings=['У отправителя и получателя совпадает ИИН, но счета разные. Принимающего счёта нет в проверенном справочнике accounts. Это не доказывает расход.'];
   o.questions=['Деньги переведены на другой учитываемый счёт компании или выведены собственнику? Для внутреннего перевода нужна принимающая сторона и её выписка.'];
  }else if(suffix==='2222'&&doc==='2203'){
   o.findings=['Получатель — SYNTHETIC COMPANY A, счёт …3333 есть в accounts. Банк указывает «Возврат за непредоставленные услуги».'];
   o.questions=['Какое первоначальное поступление/обязательство возвращено? Нужна ссылка на него и подтверждение принимающей стороны. Не считать новым постоянным расходом.'];
  }else{o.questions=['Неизвестная для этого образца операция. Требуется отдельная проверка.'];}
  if(op.identityReview){o.state='needs_information';o.questions.unshift(op.identityReview);}
  return o;
 });
 const accountIssues=[];
 for(const statement of batch.statements){const aliases=accounts.filter(r=>clean(r[3])===statement.account);if(aliases.length!==1)accountIssues.push({accountSuffix:statement.account.slice(-4),title:'Проверить справочник счетов',question:`IBAN …${statement.account.slice(-4)} в выписке принадлежит ${statement.company}. В accounts ему соответствуют ${aliases.length} записей: ${aliases.map(r=>r[0]).join('; ')||'нет'}. Выбрать правильную запись и отдельно согласовать исправление справочника.`});}
 return {schemaVersion:1,mode:'preview_only',postingEnabled:false,checkedAt:evidence.checkedAt,sourceDate:'15.09.2026',
  coverage:'Прочитаны выписки и актуальные trips!A2:AN3, accounts!A1:D21, payments!A1:G70. Поиск клиентов/счетов: trips!A1:AF1000. Finmap и весь ручной финансовый журнал не сверены. «Нет вопроса» не означает «новая операция» или «можно провести».',
  accountIssues,operations,repeatedFiles:batch.repeatedFiles,statements:batch.statements.map(({operations,...s})=>({...s,accountSuffix:s.account.slice(-4),count:operations.length})),
  counts:{total:operations.length,needsInformation:operations.filter(o=>o.state==='needs_information').length,alreadyRecorded:operations.filter(o=>o.state==='already_recorded').length,noBusinessQuestion:operations.filter(o=>o.state==='no_business_question').length}};
}
