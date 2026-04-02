// NocoDB-Backend – Adapter für bestehende Deployments (DB_BACKEND=nocodb)
// Kapselt alle NocoDB HTTP-Calls hinter dem gleichen Interface wie sqlite.js

const https = require('https');

const NOCODB_URL     = process.env.NOCODB_URL        || 'https://nocodb.f3-events.de';
const NOCODB_TOKEN   = process.env.NOCODB_TOKEN       || '';
const NOCODB_PROJECT = process.env.NOCODB_PROJECT_ID  || 'pu4jkb0uwe4ebev';
const T_COOKIES      = process.env.NOCODB_TABLE_ID             || 'mmvneegxgeltpav';
const T_EVENTS       = process.env.NOCODB_TABLE_EVENTS         || 'mo0qnkmte1sl1mj';
const T_LV           = process.env.NOCODB_TABLE_LADIES_VOTING  || 'm9qmqh26mhpnlld';

function nocoReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(NOCODB_URL + path);
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'xc-token': NOCODB_TOKEN, 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('NocoDB Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function base(table) {
  return `/api/v1/db/data/noco/${NOCODB_PROJECT}/${table}`;
}

module.exports = {
  async getCookies() {
    return nocoReq('GET', `${base(T_COOKIES)}?limit=10`);
  },

  async updateCookies(id, data) {
    await nocoReq('PATCH', `${base(T_COOKIES)}/${id}`, data);
  },

  async getEvents({ status, limit = 100, offset = 0 } = {}) {
    let qs = `?limit=${limit}&offset=${offset}`;
    if (status) qs += `&where=(Status,eq,${encodeURIComponent(status)})`;
    return nocoReq('GET', `${base(T_EVENTS)}${qs}`);
  },

  async getEvent(id) {
    return nocoReq('GET', `${base(T_EVENTS)}/${id}`);
  },

  async createEvent(data) {
    return nocoReq('POST', base(T_EVENTS), data);
  },

  async updateEvent(id, data) {
    await nocoReq('PATCH', `${base(T_EVENTS)}/${id}`, data);
  },

  async getLadiesVoting({ status, limit = 100, offset = 0 } = {}) {
    let qs = `?limit=${limit}&offset=${offset}&sort=-CreatedAt`;
    if (status) qs += `&where=(Status,eq,${encodeURIComponent(status)})`;
    return nocoReq('GET', `${base(T_LV)}${qs}`);
  },

  async createLadiesVotingCandidate(data) {
    return nocoReq('POST', base(T_LV), data);
  },

  async updateLadiesVotingCandidate(id, data) {
    await nocoReq('PATCH', `${base(T_LV)}/${id}`, data);
  },
};
