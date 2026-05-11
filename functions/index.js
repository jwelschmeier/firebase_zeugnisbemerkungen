const admin = require('firebase-admin');
const cors = require('cors');
const express = require('express');
const { google } = require('googleapis');
const { onRequest } = require('firebase-functions/v2/https');

admin.initializeApp();

const db = admin.firestore();
const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));

const DEFAULT_PROPOSAL_DESC = 'Beispiel: 12.01.2026 - 18.01.2026';
const DEFAULT_VOTING_DESC = 'Beispiel: 19.01.2026 - 23.01.2026';
const PHOTO_FOLDER_ID = '1Ehe7wxbYbysV-Nwe2G8tI2k5tF7LQ_vA';
const COLLECTIONS = {
  students: 'students',
  comments: 'comments',
  proposals: 'proposals',
  votes: 'votes',
  settings: 'settings'
};

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeHeader(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function drivePhotoUrl(photoId, size = 150) {
  const id = normalizeText(photoId);
  return id ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=${size}` : '';
}

function firestoreDocId(value) {
  const id = normalizeText(value);
  return id && !id.includes('/') ? id : '';
}

function replaceUmlauts(value) {
  return String(value || '')
    .replace(/Ä/g, 'Ae').replace(/ä/g, 'ae')
    .replace(/Ö/g, 'Oe').replace(/ö/g, 'oe')
    .replace(/Ü/g, 'Ue').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

function buildPhotoFileNameCandidates(klasse, vorname, nachname) {
  if (!klasse || !vorname || !nachname) return [];

  const classMatch = String(klasse).trim().match(/^0?(\d+)/);
  const classNum = classMatch ? parseInt(classMatch[1], 10) : 5;
  const today = new Date();
  const schoolStartYear = today.getMonth() + 1 >= 8 ? today.getFullYear() : today.getFullYear() - 1;
  const gradYear = (schoolStartYear + 11) - classNum;
  const firstName = replaceUmlauts(vorname).trim();
  const lastName = replaceUmlauts(nachname).trim();

  if (firstName.length < 3 || lastName.length < 3) return [];
  const baseName = `${firstName.substring(0, 3)}${lastName.substring(0, 3)}`.toLowerCase() + gradYear;
  return [`${baseName}.jpg`, `${baseName}.jpeg`, `${baseName}.png`, `${baseName}.JPG`];
}

async function listDriveFolderFiles(folderId) {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });
  const drive = google.drive({ version: 'v3', auth });
  const files = [];
  let pageToken;

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    files.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return files;
}

function parseCsv(content, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const text = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((r) => r.some((v) => String(v || '').trim() !== ''));
}

async function setSetting(key, value) {
  await db.collection(COLLECTIONS.settings).doc(key).set({
    value: String(value ?? ''),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function getSetting(key) {
  const snap = await db.collection(COLLECTIONS.settings).doc(key).get();
  if (!snap.exists) return null;
  return String((snap.data() || {}).value ?? '');
}

function parseDateDE(value) {
  const match = String(value || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!match) return null;
  const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  date.setHours(0, 0, 0, 0);
  return date;
}

function isDateInString(checkDate, text) {
  const dates = String(text || '').match(/\d{1,2}\.\d{1,2}\.\d{4}/g) || [];
  if (dates.length < 2) return false;
  const start = parseDateDE(dates[0]);
  const end = parseDateDE(dates[1]);
  return Boolean(start && end && checkDate >= start && checkDate <= end);
}

async function getPhaseDescriptions() {
  return {
    proposal: (await getSetting('PHASE_DESC_PROPOSAL')) || DEFAULT_PROPOSAL_DESC,
    voting: (await getSetting('PHASE_DESC_VOTING')) || DEFAULT_VOTING_DESC
  };
}

async function getAppPhase() {
  const manualOverride = (await getSetting('MANUAL_OVERRIDE')) || 'false';
  const manualPhase = (await getSetting('PHASE')) || 'PROPOSAL';
  const desc = await getPhaseDescriptions();
  let phase = manualPhase;

  if (manualOverride !== 'true') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (isDateInString(today, desc.voting)) phase = 'VOTING';
    else if (isDateInString(today, desc.proposal)) phase = 'PROPOSAL';
  }

  return phase === 'VOTING' ? 'VOTING' : 'PROPOSAL';
}

async function getAdminInitData() {
  const phase = await getAppPhase();
  return { phase, descriptions: await getPhaseDescriptions() };
}

async function savePhaseDescriptions(input, maybeVoting) {
  const proposal = typeof input === 'object' && input !== null ? input.proposal : input;
  const voting = typeof input === 'object' && input !== null ? input.voting : maybeVoting;
  await setSetting('PHASE_DESC_PROPOSAL', proposal || '');
  await setSetting('PHASE_DESC_VOTING', voting || '');
  return { success: true, message: 'Zeitraeume erfolgreich gespeichert.' };
}

async function setAppPhase(phaseName) {
  await setSetting('PHASE', phaseName === 'VOTING' ? 'VOTING' : 'PROPOSAL');
  await setSetting('MANUAL_OVERRIDE', 'true');
  return { success: true, message: 'Phase manuell geaendert auf: ' + phaseName };
}

async function enableAutoMode() {
  await setSetting('MANUAL_OVERRIDE', 'false');
  return { success: true, message: 'Automatik-Modus aktiviert' };
}

async function verifyAdminPassword(inputPassword) {
  const configured = process.env.ADMIN_PASSWORD || 'schule123';
  return String(inputPassword || '') === configured;
}

async function deleteCollection(collectionName) {
  const batchSize = 450;
  while (true) {
    const snap = await db.collection(collectionName).limit(batchSize).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

async function saveStudentsToDb(rows) {
  await deleteCollection(COLLECTIONS.students);
  let batch = db.batch();
  let opCount = 0;
  const now = admin.firestore.FieldValue.serverTimestamp();
  for (const row of rows) {
    const klasse = normalizeText(row[0]);
    const nachname = normalizeText(row[1]);
    const vorname = normalizeText(row[2]);
    if (!klasse || !nachname || !vorname) continue;
    const requestedId = firestoreDocId(row[5]);
    const photoId = normalizeText(row[4]);
    const photoUrl = normalizeText(row[6]) || drivePhotoUrl(photoId);
    const doc = requestedId ? db.collection(COLLECTIONS.students).doc(requestedId) : db.collection(COLLECTIONS.students).doc();
    batch.set(doc, {
      id: doc.id,
      klasse,
      nachname,
      vorname,
      email: normalizeText(row[3]),
      photoId,
      photoUrl,
      search: normalizeKey(`${klasse} ${nachname} ${vorname}`),
      createdAt: now,
      updatedAt: now
    });
    opCount += 1;
    if (opCount >= 450) {
      await batch.commit();
      batch = db.batch();
      opCount = 0;
    }
  }
  if (opCount > 0) await batch.commit();
}

async function saveCommentsToDb(rows) {
  await deleteCollection(COLLECTIONS.comments);
  let batch = db.batch();
  let opCount = 0;
  const now = admin.firestore.FieldValue.serverTimestamp();
  for (const row of rows) {
    const requestedId = normalizeText(row[0]).replace(/^#/, '');
    const doc = requestedId ? db.collection(COLLECTIONS.comments).doc(requestedId) : db.collection(COLLECTIONS.comments).doc();
    const text = normalizeText(row[2]);
    const category = normalizeText(row[1]) || 'Allgemein';
    if (!text) continue;
    batch.set(doc, {
      id: doc.id,
      legacyId: normalizeText(row[0]),
      kategorie: category,
      category,
      text,
      istFreitext: row[3] === true || String(row[3]).toLowerCase() === 'true',
      updatedAt: now
    });
    opCount += 1;
    if (opCount >= 450) {
      await batch.commit();
      batch = db.batch();
      opCount = 0;
    }
  }
  if (opCount > 0) await batch.commit();
}

async function importStudentsCSV(csvContent) {
  const firstLine = String(csvContent || '').split('\n')[0] || '';
  const delimiter = firstLine.includes(';') ? ';' : ',';
  const rows = parseCsv(csvContent, delimiter);
  const header = rows[0] || [];
  const headerMap = {};
  header.forEach((name, index) => { headerMap[normalizeHeader(name)] = index; });
  const hasNamedColumns = headerMap.vorname !== undefined && headerMap.nachname !== undefined && headerMap.klasse !== undefined;
  const startIndex = hasNamedColumns ? 1 : 0;

  const get = (row, name, fallbackIndex) => {
    const index = headerMap[name] !== undefined ? headerMap[name] : fallbackIndex;
    return row[index];
  };

  const cleaned = rows.slice(startIndex)
    .filter((row) => row && row.length >= 3)
    .map((row) => {
      if (hasNamedColumns) {
        return [
          get(row, 'klasse', 2),
          get(row, 'nachname', 1),
          get(row, 'vorname', 0),
          get(row, 'email', 4),
          get(row, 'photoid', 5),
          get(row, 'id', 0),
          get(row, 'photourl', 6)
        ];
      }
      return [row[2], row[1], row[0], row[3], row[4], '', row[5]];
    })
    .filter((row) => normalizeText(row[0]) && normalizeText(row[1]) && normalizeText(row[2]));

  await saveStudentsToDb(cleaned);
  return { success: true, message: `${cleaned.length} Schueler importiert.` };
}

async function importCommentsTXT(txtContent) {
  const rows = parseCsv(txtContent, ',');
  const cleaned = rows
    .filter((row) => row && row.length >= 3 && normalizeText(row[0]).startsWith('#'))
    .map((row) => [row[0], row[1] || 'Allgemein', row[2], false])
    .filter((row) => normalizeText(row[2]));

  await saveCommentsToDb(cleaned);
  return { success: true, message: `${cleaned.length} Bemerkungen importiert.` };
}

async function importData(payload) {
  const results = [];
  if (payload && payload.students) {
    const result = await importStudentsCSV(payload.students);
    results.push(result.message);
  }
  if (payload && payload.comments) {
    const result = await importCommentsTXT(payload.comments);
    results.push(result.message);
  }
  return { success: true, message: results.join(' | ') };
}

async function getStudentsByClass(className) {
  const snap = await db.collection(COLLECTIONS.students).where('klasse', '==', className).get();
  return snap.docs.map((doc) => {
    const data = doc.data();
    return { id: doc.id, ...data, photoUrl: data.photoUrl || drivePhotoUrl(data.photoId), proposals: [] };
  }).sort((a, b) => `${a.nachname || ''} ${a.vorname || ''}`.localeCompare(`${b.nachname || ''} ${b.vorname || ''}`));
}

async function getProposalVoteMaps(proposalIds, userEmail) {
  const voteCounts = {};
  const myVotes = {};
  if (!proposalIds.length) return { voteCounts, myVotes };

  const chunks = [];
  for (let i = 0; i < proposalIds.length; i += 30) chunks.push(proposalIds.slice(i, i + 30));
  for (const ids of chunks) {
    const snap = await db.collection(COLLECTIONS.votes).where('proposalId', 'in', ids).get();
    snap.docs.forEach((doc) => {
      const vote = doc.data();
      const pid = vote.proposalId;
      voteCounts[pid] = voteCounts[pid] || { pos: 0, neg: 0, votersPos: [], votersNeg: [] };
      if (Number(vote.value) > 0) {
        voteCounts[pid].pos += 1;
        voteCounts[pid].votersPos.push(vote.teacherEmail);
      } else if (Number(vote.value) < 0) {
        voteCounts[pid].neg += 1;
        voteCounts[pid].votersNeg.push(vote.teacherEmail);
      }
      if (userEmail && vote.teacherEmail === userEmail) myVotes[pid] = Number(vote.value);
    });
  }
  return { voteCounts, myVotes };
}

async function attachProposals(students, phase, userEmail) {
  const ids = students.map((student) => student.id);
  if (!ids.length) return students;
  const byStudent = {};
  students.forEach((student) => { byStudent[student.id] = student; });
  const proposals = [];

  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const snap = await db.collection(COLLECTIONS.proposals).where('studentId', 'in', chunk).get();
    snap.docs.forEach((doc) => {
      const data = doc.data();
      if (data.deleted === true || String(data.deleted).toLowerCase() === 'true') return;
      proposals.push({ id: doc.id, ...data });
    });
  }

  const { voteCounts, myVotes } = phase === 'VOTING'
    ? await getProposalVoteMaps(proposals.map((p) => p.id), userEmail)
    : { voteCounts: {}, myVotes: {} };

  proposals.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  proposals.forEach((proposal) => {
    const counts = voteCounts[proposal.id] || { pos: 0, neg: 0, votersPos: [], votersNeg: [] };
    const student = byStudent[proposal.studentId];
    if (!student) return;
    student.proposals.push({
      id: proposal.id,
      text: proposal.text,
      creator: proposal.creator,
      canDelete: proposal.creator === userEmail,
      pos: counts.pos,
      neg: counts.neg,
      votersPos: counts.votersPos.join(', '),
      votersNeg: counts.votersNeg.join(', '),
      myVote: myVotes[proposal.id] || 0
    });
  });

  return students;
}

async function getTeacherSummary() {
  const phase = await getAppPhase();
  const desc = await getPhaseDescriptions();
  const snap = await db.collection(COLLECTIONS.students).select('klasse').get();
  const classNames = Array.from(new Set(snap.docs.map((doc) => normalizeText(doc.data().klasse)).filter(Boolean))).sort();
  return {
    success: true,
    phase,
    phaseDescription: phase === 'VOTING' ? desc.voting : desc.proposal,
    classNames,
    userEmail: ''
  };
}

async function getStudentsForClass(className) {
  const phase = await getAppPhase();
  const desc = await getPhaseDescriptions();
  const students = await attachProposals(await getStudentsByClass(className), phase, '');
  return {
    success: true,
    phase,
    phaseDescription: phase === 'VOTING' ? desc.voting : desc.proposal,
    studentsByClass: { [className]: students }
  };
}

async function getStudentsForClassLight(className) {
  return getStudentsForClass(className);
}

async function getProposalsForClass(className) {
  return getStudentsForClass(className);
}

async function getProposalsForClassAndEnsureVotes(className) {
  return getStudentsForClass(className);
}

async function getTeacherData() {
  const summary = await getTeacherSummary();
  const studentsByClass = {};
  for (const className of summary.classNames) {
    studentsByClass[className] = (await getStudentsForClass(className)).studentsByClass[className];
  }
  return { ...summary, studentsByClass };
}

async function searchStudentsAcrossClasses(query, limit = 20) {
  const q = normalizeKey(query);
  if (!q) return { success: true, results: [], limited: false, totalMatches: 0 };
  const snap = await db.collection(COLLECTIONS.students).limit(1000).get();
  const matches = snap.docs
    .map((doc) => {
      const data = doc.data();
      return { id: doc.id, ...data, photoUrl: data.photoUrl || drivePhotoUrl(data.photoId, 120) };
    })
    .filter((student) => normalizeKey(`${student.klasse} ${student.nachname} ${student.vorname}`).includes(q))
    .sort((a, b) => `${a.klasse} ${a.nachname}`.localeCompare(`${b.klasse} ${b.nachname}`));
  const max = Number(limit) || 20;
  return { success: true, results: matches.slice(0, max), limited: matches.length > max, totalMatches: matches.length };
}

async function saveProposalsV2(input) {
  const proposals = Array.isArray(input) ? input : [input];
  const batch = db.batch();
  const now = admin.firestore.Timestamp.now();
  const saved = [];
  const clientKeyMap = {};
  const affectedClasses = new Set();

  proposals.forEach((proposal) => {
    if (!proposal || !proposal.studentId || !normalizeText(proposal.text)) return;
    const doc = db.collection(COLLECTIONS.proposals).doc();
    const data = {
      id: doc.id,
      studentId: String(proposal.studentId),
      className: normalizeText(proposal.className || proposal.klasse),
      text: normalizeText(proposal.text),
      creator: normalizeText(proposal.creator || proposal.creatorEmail || ''),
      clientKey: normalizeText(proposal.clientKey || ''),
      deleted: false,
      createdAt: now,
      updatedAt: now
    };
    batch.set(doc, data);
    saved.push(data);
    if (data.clientKey) clientKeyMap[data.clientKey] = doc.id;
    if (data.className) affectedClasses.add(data.className);
  });

  await batch.commit();
  const className = Array.from(affectedClasses)[0] || saved[0]?.className || '';
  const refreshed = className ? await getStudentsForClass(className) : null;
  const proposalsByStudent = {};
  if (refreshed && refreshed.studentsByClass[className]) {
    refreshed.studentsByClass[className].forEach((student) => {
      proposalsByStudent[student.id] = student.proposals || [];
    });
  }
  return {
    success: true,
    proposals: saved,
    saved,
    clientKeyMap,
    proposalsByStudent,
    className,
    phase: refreshed?.phase,
    phaseDescription: refreshed?.phaseDescription,
    studentsByClass: refreshed?.studentsByClass
  };
}

async function saveBulkProposals(proposals) {
  return saveProposalsV2(proposals);
}

async function deleteProposalV2(proposalId) {
  const before = await db.collection(COLLECTIONS.proposals).doc(String(proposalId)).get();
  const proposal = before.exists ? before.data() : {};
  await db.collection(COLLECTIONS.proposals).doc(String(proposalId)).set({
    deleted: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  const className = proposal.className || '';
  const studentId = proposal.studentId || '';
  const refreshed = className ? await getStudentsForClass(className) : null;
  const proposalsByStudent = {};
  if (refreshed && refreshed.studentsByClass[className]) {
    refreshed.studentsByClass[className].forEach((student) => {
      proposalsByStudent[student.id] = student.proposals || [];
    });
  }
  return { success: true, proposalsByStudent, className, studentId };
}

async function deleteProposal(proposalId) {
  return deleteProposalV2(proposalId);
}

async function castVote(input, maybeValue) {
  const proposalId = typeof input === 'object' && input !== null ? input.proposalId : input;
  const value = typeof input === 'object' && input !== null ? input.value : maybeValue;
  const teacherEmail = normalizeText((typeof input === 'object' && input !== null ? input.teacherEmail : '') || 'anonymous');
  const rawValue = Number(value);
  const voteId = `${proposalId}_${teacherEmail.replace(/[^\w.-]/g, '_')}`;
  if (rawValue === 0) {
    await db.collection(COLLECTIONS.votes).doc(voteId).delete().catch(() => {});
  } else {
    const voteValue = rawValue > 0 ? 1 : -1;
    await db.collection(COLLECTIONS.votes).doc(voteId).set({
      proposalId: String(proposalId),
      teacherEmail,
      value: voteValue,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
  const { voteCounts, myVotes } = await getProposalVoteMaps([String(proposalId)], teacherEmail);
  const counts = voteCounts[String(proposalId)] || { pos: 0, neg: 0, votersPos: [], votersNeg: [] };
  return {
    success: true,
    myVote: myVotes[String(proposalId)] || 0,
    pos: counts.pos,
    neg: counts.neg,
    votersPos: counts.votersPos.join(', '),
    votersNeg: counts.votersNeg.join(', ')
  };
}

async function getAvailableComments() {
  const snap = await db.collection(COLLECTIONS.comments).get();
  return snap.docs
    .map((doc) => {
      const data = doc.data() || {};
      const category = data.category || data.kategorie || 'Allgemein';
      return { id: doc.id, ...data, category, kategorie: category };
    })
    .sort((a, b) => `${a.category || ''} ${a.text || ''}`.localeCompare(`${b.category || ''} ${b.text || ''}`));
}

async function getAllStudents() {
  const snap = await db.collection(COLLECTIONS.students).get();
  return {
    success: true,
    students: snap.docs.map((doc) => {
      const data = doc.data();
      return { id: doc.id, ...data, photoUrl: data.photoUrl || drivePhotoUrl(data.photoId) };
    }).sort((a, b) => `${a.klasse || ''} ${a.nachname || ''} ${a.vorname || ''}`.localeCompare(`${b.klasse || ''} ${b.nachname || ''} ${b.vorname || ''}`))
  };
}

async function deleteAllProposals() {
  await deleteCollection(COLLECTIONS.proposals);
  await deleteCollection(COLLECTIONS.votes);
  return { success: true, message: 'Alle Vorschlaege und Stimmen wurden geloescht.' };
}

async function deleteProposalsForStudents(studentIds) {
  const ids = Array.isArray(studentIds) ? studentIds : [];
  for (let i = 0; i < ids.length; i += 30) {
    const snap = await db.collection(COLLECTIONS.proposals).where('studentId', 'in', ids.slice(i, i + 30)).get();
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.set(doc.ref, { deleted: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }));
    await batch.commit();
  }
  return { success: true, message: 'Vorschlaege geloescht.' };
}

async function resetVotesForStudents(studentIds) {
  const ids = Array.isArray(studentIds) ? studentIds : [];
  const proposalIds = [];
  for (let i = 0; i < ids.length; i += 30) {
    const snap = await db.collection(COLLECTIONS.proposals).where('studentId', 'in', ids.slice(i, i + 30)).get();
    snap.docs.forEach((doc) => proposalIds.push(doc.id));
  }
  for (let i = 0; i < proposalIds.length; i += 30) {
    const snap = await db.collection(COLLECTIONS.votes).where('proposalId', 'in', proposalIds.slice(i, i + 30)).get();
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
  return { success: true, message: 'Stimmen zurueckgesetzt.' };
}

async function loadStudentPhotos(students) {
  const photos = {};
  (Array.isArray(students) ? students : []).forEach((student) => {
    if (!student || !student.id) return;
    const url = normalizeText(student.photoUrl) || drivePhotoUrl(student.photoId, student.photoSize || 300);
    if (url) photos[student.id] = url;
  });
  return { success: true, photos };
}

async function syncPhotosToDatabase() {
  let driveFiles;
  try {
    driveFiles = await listDriveFolderFiles(PHOTO_FOLDER_ID);
  } catch (error) {
    return {
      success: false,
      message: 'Foto-Ordner konnte nicht gelesen werden. Bitte Drive API aktivieren und den Ordner mit dem GitHub/Firebase Service Account teilen. Details: ' + (error.message || String(error))
    };
  }

  const fileMap = new Map();
  driveFiles.forEach((file) => {
    const name = normalizeText(file.name).toLowerCase();
    if (name) fileMap.set(name, file.id);
  });

  const snap = await db.collection(COLLECTIONS.students).get();
  let batch = db.batch();
  let opCount = 0;
  let updates = 0;
  let alreadyLinked = 0;
  let missing = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    let photoId = normalizeText(data.photoId);
    if (!photoId) {
      const candidates = buildPhotoFileNameCandidates(data.klasse, data.vorname, data.nachname);
      for (const candidate of candidates) {
        if (fileMap.has(candidate.toLowerCase())) {
          photoId = fileMap.get(candidate.toLowerCase());
          break;
        }
      }
    }

    if (!photoId) {
      missing += 1;
      continue;
    }

    const photoUrl = drivePhotoUrl(photoId);
    if (data.photoId === photoId && data.photoUrl === photoUrl) {
      alreadyLinked += 1;
      continue;
    }

    batch.set(doc.ref, {
      photoId,
      photoUrl,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    opCount += 1;
    updates += 1;
    if (opCount >= 450) {
      await batch.commit();
      batch = db.batch();
      opCount = 0;
    }
  }
  if (opCount > 0) await batch.commit();
  return {
    success: true,
    message: `Foto-Sync fertig. ${updates} Fotos neu verknuepft, ${alreadyLinked} bereits verknuepft, ${missing} ohne Treffer.`
  };
}

async function rebuildIndexes() {
  return { success: true, message: 'Firestore benoetigt keinen manuellen Index-Rebuild fuer diese Migration.' };
}

async function analyzeOrphanedProposals() {
  return { success: true, orphaned: [] };
}

const handlers = {
  analyzeOrphanedProposals,
  castVote,
  deleteAllProposals,
  deleteProposal,
  deleteProposalV2,
  deleteProposalsForStudents,
  enableAutoMode,
  getAdminInitData,
  getAllStudents,
  getAppPhase,
  getAvailableComments,
  getProposalsForClass,
  getProposalsForClassAndEnsureVotes,
  getPhaseDescriptions,
  getStudentsForClass,
  getStudentsForClassLight,
  getTeacherData,
  getTeacherSummary,
  importCommentsTXT,
  importData,
  importStudentsCSV,
  loadStudentPhotos,
  rebuildIndexes,
  resetVotesForStudents,
  saveBulkProposals,
  savePhaseDescriptions,
  saveProposalsV2,
  searchStudentsAcrossClasses,
  setAppPhase,
  syncPhotosToDatabase,
  verifyAdminPassword
};

app.get(['/health', '/api/health'], (_req, res) => {
  res.json({ ok: true, project: 'zeugnisbemerkungen-fsr' });
});

app.post(['/call', '/api/call'], async (req, res) => {
  try {
    const functionName = String(req.body.functionName || '');
    const args = Array.isArray(req.body.args) ? req.body.args : [];
    const handler = handlers[functionName];
    if (!handler) {
      res.status(404).json({ error: `Unbekannte Funktion: ${functionName}` });
      return;
    }
    const result = await handler(...args);
    res.json({ result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error) });
  }
});

exports.api = onRequest({ region: 'europe-west3', timeoutSeconds: 120, memory: '512MiB' }, app);
