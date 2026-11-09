// Firestore নিরাপত্তার নিয়মের স্বয়ংক্রিয় টেস্ট (এমুলেটরে চলে, আসল ডেটা ছোঁয় না)
// চালাতে: npm run test:rules
import {test, before, after, beforeEach} from 'node:test';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment, assertSucceeds, assertFails} from '@firebase/rules-unit-testing';
import {doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp, runTransaction} from 'firebase/firestore';

let env;
const ADMIN = 'admin1', GUEST = 'guest1', STRANGER = 'stranger1', OFF = 'off1', ADMIN2 = 'admin2';

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-ebm',
    firestore: {rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080},
  });
});
after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const u = (role, active = true) => ({email: role + '@x.com', name: role, role, active, updatedAt: new Date(), updatedBy: 'seed'});
    await setDoc(doc(db, 'users', ADMIN), u('admin'));
    await setDoc(doc(db, 'users', ADMIN2), u('admin'));
    await setDoc(doc(db, 'users', GUEST), u('viewer'));
    await setDoc(doc(db, 'users', OFF), u('viewer', false));
    await setDoc(doc(db, 'state', 'main'), {data: '{"a":1}', rev: 5, appVer: '4.0', updatedAt: new Date(), updatedBy: ADMIN, updatedByEmail: 'a'});
    await setDoc(doc(db, 'state', 'license'), {key: 'k', updatedAt: new Date(), updatedBy: ADMIN});
    await setDoc(doc(db, 'archive', '2025'), {data: '{"y":2025}', updatedAt: new Date(), updatedBy: ADMIN});
    await setDoc(doc(db, 'audit', 'x1'), {t: new Date(), uid: ADMIN, email: 'a', action: 'save', detail: ''});
  });
});

const as = uid => env.authenticatedContext(uid, {email: uid + '@x.com'}).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const main = (uid, rev, extra = {}) => ({data: '{"b":2}', rev, appVer: '4.0', updatedAt: serverTimestamp(), updatedBy: uid, updatedByEmail: uid + '@x.com', ...extra});
const audit = (uid, action, extra = {}) => ({t: serverTimestamp(), uid, email: uid + '@x.com', action, detail: '', ...extra});

// ---------- লগইন ছাড়া / অচেনা ----------
test('লগইন ছাড়া কিছুই পড়া যায় না', async () => {
  const db = anon();
  await assertFails(getDoc(doc(db, 'state', 'main')));
  await assertFails(getDoc(doc(db, 'archive', '2025')));
  await assertFails(getDoc(doc(db, 'users', ADMIN)));
  await assertFails(getDocs(collection(db, 'audit')));
});
test('লগইন করা কিন্তু users তালিকায় নেই: কিছুই পড়া/লেখা যায় না', async () => {
  const db = as(STRANGER);
  await assertFails(getDoc(doc(db, 'state', 'main')));
  await assertFails(getDoc(doc(db, 'state', 'license')));
  await assertFails(getDoc(doc(db, 'archive', '2025')));
  await assertFails(setDoc(doc(db, 'users', STRANGER), {email: 'x', name: 'x', role: 'admin', active: true, updatedAt: serverTimestamp(), updatedBy: STRANGER}));
  await assertFails(setDoc(doc(db, 'audit', 'z'), audit(STRANGER, 'login')));
});
test('নিষ্ক্রিয় ব্যবহারকারী: নিজের প্রোফাইল ছাড়া কিছু পড়া যায় না', async () => {
  const db = as(OFF);
  await assertSucceeds(getDoc(doc(db, 'users', OFF)));
  await assertFails(getDoc(doc(db, 'state', 'main')));
  await assertFails(getDoc(doc(db, 'archive', '2025')));
});

// ---------- guest ----------
test('guest: ডেটা, আর্কাইভ, লাইসেন্স পড়তে পারে', async () => {
  const db = as(GUEST);
  await assertSucceeds(getDoc(doc(db, 'state', 'main')));
  await assertSucceeds(getDoc(doc(db, 'state', 'license')));
  await assertSucceeds(getDoc(doc(db, 'archive', '2025')));
  await assertSucceeds(getDocs(collection(db, 'archive')));
  await assertSucceeds(getDoc(doc(db, 'users', GUEST)));
});
test('guest: কিছুই লিখতে বা মুছতে পারে না', async () => {
  const db = as(GUEST);
  await assertFails(setDoc(doc(db, 'state', 'main'), main(GUEST, 6)));
  await assertFails(updateDoc(doc(db, 'state', 'main'), {data: '{}'}));
  await assertFails(deleteDoc(doc(db, 'state', 'main')));
  await assertFails(setDoc(doc(db, 'state', 'license'), {key: 'x', updatedAt: serverTimestamp(), updatedBy: GUEST}));
  await assertFails(setDoc(doc(db, 'archive', '2026'), {data: '{"a":1}', updatedAt: serverTimestamp(), updatedBy: GUEST}));
  await assertFails(deleteDoc(doc(db, 'archive', '2025')));
});
test('guest: নিজেকে admin বানাতে বা অন্য কাউকে যোগ করতে পারে না', async () => {
  const db = as(GUEST);
  await assertFails(updateDoc(doc(db, 'users', GUEST), {role: 'admin', updatedAt: serverTimestamp(), updatedBy: GUEST}));
  await assertFails(setDoc(doc(db, 'users', 'newbie'), {email: 'n', name: 'n', role: 'viewer', active: true, updatedAt: serverTimestamp(), updatedBy: GUEST}));
});
test('guest: অন্যের প্রোফাইল, ব্যবহারকারী-তালিকা ও অডিট লগ পড়তে পারে না', async () => {
  const db = as(GUEST);
  await assertFails(getDoc(doc(db, 'users', ADMIN)));
  await assertFails(getDocs(collection(db, 'users')));
  await assertFails(getDocs(collection(db, 'audit')));
  await assertFails(getDoc(doc(db, 'audit', 'x1')));
});
test('guest: অডিটে শুধু login/logout লিখতে পারে, অন্যের নামে নয়', async () => {
  const db = as(GUEST);
  await assertSucceeds(setDoc(doc(db, 'audit', 'g1'), audit(GUEST, 'login')));
  await assertFails(setDoc(doc(db, 'audit', 'g2'), audit(GUEST, 'save')));
  await assertFails(setDoc(doc(db, 'audit', 'g3'), audit(ADMIN, 'login')));
});

// ---------- admin ----------
test('admin: ঠিক rev+1 দিয়ে চলতি ডেটা লিখতে পারে', async () => {
  await assertSucceeds(setDoc(doc(as(ADMIN), 'state', 'main'), main(ADMIN, 6)));
});
test('admin: পুরোনো rev দিয়ে লিখলে আটকায় (অন্যের কাজ মুছে যাওয়া ঠেকানো)', async () => {
  const db = as(ADMIN);
  await assertFails(setDoc(doc(db, 'state', 'main'), main(ADMIN, 5)));
  await assertFails(setDoc(doc(db, 'state', 'main'), main(ADMIN, 7)));
});
test('admin: অন্যের নামে বা ভুল সময় দিয়ে লেখা যায় না, বাড়তি ঘর যায় না', async () => {
  const db = as(ADMIN);
  await assertFails(setDoc(doc(db, 'state', 'main'), main(ADMIN, 6, {updatedBy: ADMIN2})));
  await assertFails(setDoc(doc(db, 'state', 'main'), main(ADMIN, 6, {updatedAt: new Date(2020, 0, 1)})));
  await assertFails(setDoc(doc(db, 'state', 'main'), main(ADMIN, 6, {evil: true})));
  await assertFails(setDoc(doc(db, 'state', 'main'), main(ADMIN, 6, {data: 123})));
});
test('admin: চলতি ডেটা মুছতে পারে না', async () => {
  await assertFails(deleteDoc(doc(as(ADMIN), 'state', 'main')));
});
test('admin: লেনদেনে ডেটা + অডিট একসঙ্গে লেখা যায়', async () => {
  const db = as(ADMIN);
  await assertSucceeds(runTransaction(db, async tx => {
    const s = await tx.get(doc(db, 'state', 'main'));
    tx.set(doc(db, 'state', 'main'), main(ADMIN, s.data().rev + 1));
    tx.set(doc(db, 'audit', 'a9'), audit(ADMIN, 'save'));
  }));
});
test('admin: আর্কাইভ লেখা/মোছা যায়, অবৈধ বছর-নাম নয়', async () => {
  const db = as(ADMIN);
  await assertSucceeds(setDoc(doc(db, 'archive', '2026'), {data: '{"a":1}', updatedAt: serverTimestamp(), updatedBy: ADMIN}));
  await assertSucceeds(deleteDoc(doc(db, 'archive', '2025')));
  await assertFails(setDoc(doc(db, 'archive', 'hack'), {data: '{"a":1}', updatedAt: serverTimestamp(), updatedBy: ADMIN}));
});
test('admin: guest যোগ, নিষ্ক্রিয় ও মুছতে পারে', async () => {
  const db = as(ADMIN);
  await assertSucceeds(setDoc(doc(db, 'users', 'g2'), {email: 'g2@x.com', name: 'Guest 2', role: 'viewer', active: true, updatedAt: serverTimestamp(), updatedBy: ADMIN}));
  await assertSucceeds(updateDoc(doc(db, 'users', GUEST), {active: false, updatedAt: serverTimestamp(), updatedBy: ADMIN}));
  await assertSucceeds(deleteDoc(doc(db, 'users', 'g2')));
  await assertSucceeds(getDocs(collection(db, 'users')));
  await assertSucceeds(getDocs(collection(db, 'audit')));
});
test('admin: অচেনা ভূমিকা দেওয়া যায় না', async () => {
  await assertFails(setDoc(doc(as(ADMIN), 'users', 'g3'), {email: 'g', name: 'g', role: 'superuser', active: true, updatedAt: serverTimestamp(), updatedBy: ADMIN}));
});
test('admin: নিজেকে নিষ্ক্রিয়, নিজের ভূমিকা বদল বা নিজেকে মুছতে পারে না', async () => {
  const db = as(ADMIN);
  await assertFails(updateDoc(doc(db, 'users', ADMIN), {active: false, updatedAt: serverTimestamp(), updatedBy: ADMIN}));
  await assertFails(updateDoc(doc(db, 'users', ADMIN), {role: 'viewer', updatedAt: serverTimestamp(), updatedBy: ADMIN}));
  await assertFails(deleteDoc(doc(db, 'users', ADMIN)));
});
test('অডিট লগ কেউ বদলাতে বা মুছতে পারে না, admin-ও না', async () => {
  const db = as(ADMIN);
  await assertFails(updateDoc(doc(db, 'audit', 'x1'), {detail: 'changed'}));
  await assertFails(deleteDoc(doc(db, 'audit', 'x1')));
});
test('অচেনা কালেকশনে কেউ লিখতে পারে না', async () => {
  await assertFails(setDoc(doc(as(ADMIN), 'secrets', 'x'), {a: 1}));
  await assertFails(setDoc(doc(as(ADMIN), 'state', 'other'), {a: 1}));
});
// ---------- আগের সংস্করণ (history) ----------
const hist = (uid, extra = {}) => ({data: '{"old":1}', rev: 5, act: 'save', updatedAt: serverTimestamp(), updatedBy: uid, ...extra});
const hmeta = (uid, next) => ({next, updatedAt: serverTimestamp(), updatedBy: uid});
test('admin: লেনদেনে ডেটা + আগের কপি + meta একসঙ্গে লেখা ও পড়া যায়', async () => {
  const db = as(ADMIN);
  await assertSucceeds(runTransaction(db, async tx => {
    const s = await tx.get(doc(db, 'state', 'main')), m = await tx.get(doc(db, 'history', 'meta'));
    const n = m.exists() ? m.data().next : 0;
    tx.set(doc(db, 'state', 'main'), main(ADMIN, s.data().rev + 1));
    tx.set(doc(db, 'history', 'h' + (n % 10)), hist(ADMIN, {data: s.data().data, rev: s.data().rev}));
    tx.set(doc(db, 'history', 'meta'), hmeta(ADMIN, n + 1));
  }));
  await assertSucceeds(getDocs(collection(db, 'history')));
});
test('history: guest পড়তে/লিখতে পারে না; অবৈধ নাম, বাড়তি ঘর, মোছা আটকায়', async () => {
  const g = as(GUEST), a = as(ADMIN);
  await assertFails(getDocs(collection(g, 'history')));
  await assertFails(setDoc(doc(g, 'history', 'h1'), hist(GUEST)));
  await assertFails(setDoc(doc(a, 'history', 'h10'), hist(ADMIN)));
  await assertFails(setDoc(doc(a, 'history', 'h1'), hist(ADMIN, {evil: 1})));
  await assertFails(setDoc(doc(a, 'history', 'h1'), hist(ADMIN, {updatedBy: ADMIN2})));
  await assertFails(setDoc(doc(a, 'history', 'meta'), {next: 'x', updatedAt: serverTimestamp(), updatedBy: ADMIN}));
  await assertSucceeds(setDoc(doc(a, 'history', 'h1'), hist(ADMIN)));
  await assertFails(deleteDoc(doc(a, 'history', 'h1')));
});
test('নিষ্ক্রিয় করা admin কিছু লিখতে পারে না', async () => {
  await env.withSecurityRulesDisabled(async ctx => { await updateDoc(doc(ctx.firestore(), 'users', ADMIN2), {active: false}); });
  await assertFails(setDoc(doc(as(ADMIN2), 'state', 'main'), main(ADMIN2, 6)));
});
