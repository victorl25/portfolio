// UI stand-ins for running app.js commands outside the browser
globalThis.setTimeout = fn => { Promise.resolve().then(fn); return 0; };
globalThis.dialogLog = [];
globalThis.Dialogs = {
  custom: () => ({ querySelector: () => ({ textContent: '' }) }),
  close() {},
  alert: async msg => { dialogLog.push(String(msg)); },
  alertHtml: async html => { dialogLog.push(String(html).replace(/<[^>]+>/g, ' ')); },
  confirm: async () => true,
};
