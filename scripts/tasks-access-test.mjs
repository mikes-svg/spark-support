import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithCustomToken, signOut } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, collection } from 'firebase/firestore';
import admin from 'firebase-admin';
const PROJECT='spark-support-28ed9';
process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099';
admin.initializeApp({ projectId: PROJECT });
const adb=admin.firestore();
await adb.collection('profiles').doc('ta-granted').set({ name:'Granted', email:'g@x.com', role:'user', tasksAccess:true });
await adb.collection('profiles').doc('ta-denied').set({ name:'Denied', email:'d@x.com', role:'user', tasksAccess:false });
await adb.collection('profiles').doc('ta-mgr').set({ name:'Manager', email:'m@x.com', role:'admin' });
await adb.collection('profiles').doc('ta-super').set({ name:'Super', email:'s@x.com', role:'superadmin' });
await adb.collection('tasks').doc('TA1').set({ title:'x', listId:'l', spaceId:'s', statusType:'todo', assigneeIds:[], creatorId:'ta-granted', participants:['ta-granted'] });

const app=initializeApp({ apiKey:'demo', projectId:PROJECT });
const auth=getAuth(app); connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
const cdb=getFirestore(app); connectFirestoreEmulator(cdb,'127.0.0.1',8080);
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString('base64url');
const token=(uid)=>{const n=Math.floor(Date.now()/1000);return [b64({alg:'none',typ:'JWT'}),b64({uid,iat:n,exp:n+3600,aud:'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',iss:'firebase-auth-emulator@example.com',sub:'firebase-auth-emulator@example.com'}),''].join('.');};
const as=async(u)=>{await signOut(auth).catch(()=>{});await signInWithCustomToken(auth,token(u));};
let pass=0,fail=0;
const check=async(label,expect,fn)=>{let got='ALLOW';try{await fn();}catch(e){got=(e.code||'').includes('permission')?'DENY':`ERR(${e.code||e.message})`;}
  const ok=got===expect; ok?pass++:fail++; console.log(`  ${ok?'PASS':'FAIL'}  ${label} → expected ${expect}, got ${got}`);};

console.log('\nTasks access gate\n');
await as('ta-granted');
await check('Granted User reads tasks','ALLOW',()=>getDocs(collection(cdb,'tasks')));
await check('Granted User reads taskLists','ALLOW',()=>getDocs(collection(cdb,'taskLists')));
await as('ta-denied');
await check('User WITHOUT the flag reads tasks','DENY',()=>getDoc(doc(cdb,'tasks/TA1')));
await check('User WITHOUT the flag reads taskSpaces','DENY',()=>getDocs(collection(cdb,'taskSpaces')));
await as('ta-mgr');
await check('Manager without the flag reads tasks','DENY',()=>getDoc(doc(cdb,'tasks/TA1')));
await as('ta-super');
await check('Administrator always reads tasks','ALLOW',()=>getDoc(doc(cdb,'tasks/TA1')));
await check('Administrator reads taskSeries','ALLOW',()=>getDocs(collection(cdb,'taskSeries')));
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
