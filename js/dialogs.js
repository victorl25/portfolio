const Dialogs = (() => {
  function _show(html) {
    document.getElementById('modal-backdrop').classList.remove('hidden');
    const c = document.getElementById('modal-container');
    c.classList.remove('hidden');
    c.innerHTML = html;
    return c;
  }

  function close() {
    document.getElementById('modal-backdrop').classList.add('hidden');
    document.getElementById('modal-container').classList.add('hidden');
    document.getElementById('modal-container').innerHTML = '';
  }

  function alert(msg, title) {
    return new Promise(resolve => {
      title = title || 'Notice';
      const c = _show(`
        <div class="dlg">
          <div class="dlg-title">${_esc(title)}</div>
          <div class="dlg-body"><p>${_esc(msg)}</p></div>
          <div class="dlg-footer">
            <button class="btn btn-primary" id="dlg-ok">OK</button>
          </div>
        </div>`);
      c.querySelector('#dlg-ok').addEventListener('click', () => { close(); resolve(); });
    });
  }

  function confirm(msg, title) {
    return new Promise(resolve => {
      title = title || 'Confirm';
      const c = _show(`
        <div class="dlg">
          <div class="dlg-title">${_esc(title)}</div>
          <div class="dlg-body"><p>${_esc(msg)}</p></div>
          <div class="dlg-footer">
            <button class="btn btn-secondary" id="dlg-cancel">Cancel</button>
            <button class="btn btn-primary" id="dlg-ok">OK</button>
          </div>
        </div>`);
      c.querySelector('#dlg-ok').addEventListener('click', () => { close(); resolve(true); });
      c.querySelector('#dlg-cancel').addEventListener('click', () => { close(); resolve(false); });
    });
  }

  function prompt(label, defaultVal, title) {
    return new Promise(resolve => {
      title = title || 'Input';
      const c = _show(`
        <div class="dlg">
          <div class="dlg-title">${_esc(title)}</div>
          <div class="dlg-body">
            <label style="font-size:13px;color:#555;">${_esc(label)}</label>
            <input id="dlg-input" class="dlg-input" type="text" value="${_esc(defaultVal || '')}">
          </div>
          <div class="dlg-footer">
            <button class="btn btn-secondary" id="dlg-cancel">Cancel</button>
            <button class="btn btn-primary" id="dlg-ok">OK</button>
          </div>
        </div>`);
      const input = c.querySelector('#dlg-input');
      input.focus(); input.select();
      const ok = () => { const v = input.value.trim(); close(); resolve(v || null); };
      c.querySelector('#dlg-ok').addEventListener('click', ok);
      c.querySelector('#dlg-cancel').addEventListener('click', () => { close(); resolve(null); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') { close(); resolve(null); } });
    });
  }

  function alertHtml(bodyHtml, title) {
    return new Promise(resolve => {
      title = title || 'Notice';
      const c = _show(`
        <div class="dlg dlg-wide">
          <div class="dlg-title">${_esc(title)}</div>
          <div class="dlg-body">${bodyHtml}</div>
          <div class="dlg-footer">
            <button class="btn btn-primary" id="dlg-ok">OK</button>
          </div>
        </div>`);
      c.querySelector('#dlg-ok').addEventListener('click', () => { close(); resolve(); });
    });
  }

  function custom(html) {
    _show(html);
    return document.getElementById('modal-container');
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('modal-container').classList.contains('hidden')) close();
  });

  return { alert, alertHtml, confirm, prompt, custom, close };
})();
