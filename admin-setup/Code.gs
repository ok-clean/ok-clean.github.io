/**
 * 오케이청소 비공개 회원관리 대장
 * 이 코드는 비공개 Google 스프레드시트 > 확장 프로그램 > Apps Script에 붙여넣으세요.
 * GitHub에 배포하는 코드에 관리자 계정, 비밀번호 또는 스프레드시트 ID를 넣지 마세요.
 */
const SHEET_NAME = '회원관리';
const HEADERS = [
  '가입일시','쿠폰번호','이름','연락처','지역','무료서비스','이벤트수신동의',
  '추천인코드','쿠폰금액','쿠폰상태','쿠폰사용일','무료서비스상태',
  '회원등급','누적이용횟수','누적결제금액','포인트잔액','상담상태','관리메모','접수경로'
];

function onOpen(){
  SpreadsheetApp.getUi().createMenu('오케이청소 관리자')
    .addItem('관리 대장 초기화','setupSheet')
    .addItem('가입 현황 보기','showSummary')
    .addToUi();
}
function setupSheet(){
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sh=ss.getSheetByName(SHEET_NAME)||ss.insertSheet(SHEET_NAME);
  sh.getRange(1,1,1,HEADERS.length).setValues([HEADERS]);
  sh.setFrozenRows(1);
  sh.getRange(1,1,1,HEADERS.length).setBackground('#173d87').setFontColor('#ffffff').setFontWeight('bold');
  sh.setColumnWidths(1,HEADERS.length,125);
  sh.setColumnWidth(4,155); sh.setColumnWidth(18,240);
  if(!sh.getFilter()) sh.getRange(1,1,Math.max(2,sh.getLastRow()),HEADERS.length).createFilter();
  setDropdown_(sh,10,['미사용','사용','취소']);
  setDropdown_(sh,12,['미제공','제공완료','취소']);
  setDropdown_(sh,13,['새싹','실버','골드','VIP']);
  setDropdown_(sh,17,['신규','상담중','예약확정','작업완료','종료']);
  SpreadsheetApp.getUi().alert('관리 대장 준비 완료. 웹 앱 배포 후 URL을 홈페이지 config.json에 넣어 주세요.');
}
function setDropdown_(sh,col,choices){
  const rule=SpreadsheetApp.newDataValidation().requireValueInList(choices,true).build();
  sh.getRange(2,col,Math.max(1000,sh.getMaxRows()-1),1).setDataValidation(rule);
}
function doPost(e){
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) return ContentService.createTextOutput('BUSY');
  try{
    const raw=e && e.parameter && e.parameter.payload;
    if(!raw || raw.length>5000) return ContentService.createTextOutput('INVALID');
    const p=JSON.parse(raw);
    if(p.kind!=='join') return ContentService.createTextOutput('INVALID');
    const name=clean_(p.name,20), phone=clean_(p.phone,20), code=clean_(p.code,20);
    if(!name || !/^01[016789]-?\d{3,4}-?\d{4}$/.test(phone) || !/^OK-[A-Z2-9]{6}$/.test(code))
      return ContentService.createTextOutput('INVALID');
    const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if(!sh) return ContentService.createTextOutput('NOT_SETUP');
    const last=sh.getLastRow();
    if(last>1){
      const codes=sh.getRange(2,2,last-1,1).getValues().flat();
      if(codes.includes(code)) return ContentService.createTextOutput('DUPLICATE');
    }
    const row=[new Date(),code,name,phone,clean_(p.area,40),clean_(p.free,60),
      p.ad===true?'동의':'미동의',clean_(p.ref,20),Number(p.couponAmount)||10000,
      '미사용','','미제공','새싹',0,0,0,'신규','',clean_(p.source,80)];
    sh.appendRow(row);
    return ContentService.createTextOutput('OK');
  }catch(err){console.error(err);return ContentService.createTextOutput('ERROR');}
  finally{lock.releaseLock();}
}
function clean_(v,n){
  let s=String(v==null?'':v).trim().slice(0,n);
  // 시트 수식 삽입 방지
  if(/^[=+\-@]/.test(s)) s="'"+s;
  return s;
}
function showSummary(){
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if(!sh){SpreadsheetApp.getUi().alert('먼저 관리 대장을 초기화해 주세요.');return;}
  const n=Math.max(0,sh.getLastRow()-1);
  SpreadsheetApp.getUi().alert('현재 회원 가입 접수: '+n+'건\n쿠폰 상태·무료 서비스·등급·포인트는 각 행에서 관리하세요.');
}
