// app.js — 体調の隠れ相関発見ノート SPA

// ── API クライアント ────────────────────────────────────────────────────────

const api = {
  async get(path) {
    const r = await fetch(`/api${path}`);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ detail: r.statusText }));
      throw Object.assign(new Error(err.detail || r.statusText), { code: err.code });
    }
    return r.json();
  },
  async patch(path, body) {
    const r = await fetch(`/api${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async delete(path) {
    const r = await fetch(`/api${path}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
};

// ── アプリ状態 ──────────────────────────────────────────────────────────────

const state = {
  screen: 'loading',  // loading | onboarding-safety | onboarding-metrics | record | insights | experiments | settings
  settings: {},
  todayData: null,
  metrics: [],
  formValues: {},     // { metric_id: value }
  insights: [],
  experiments: [],
  newMetric: { name: '', role: 'symptom', dtype: 'binary' },
};

// ── レンダリング ────────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app');
  switch (state.screen) {
    case 'loading':
      app.innerHTML = `<div class="loading">読み込み中...</div>`;
      break;
    case 'onboarding-safety':
      app.innerHTML = renderOnboardingSafety();
      break;
    case 'onboarding-metrics':
      app.innerHTML = renderOnboardingMetrics();
      break;
    case 'record':
      app.innerHTML = renderRecord();
      break;
    case 'insights':
      app.innerHTML = renderInsights();
      break;
    case 'experiments':
      app.innerHTML = renderExperiments();
      break;
    case 'settings':
      app.innerHTML = renderSettings();
      break;
  }
  attachListeners();
}

// ── オンボーディング ────────────────────────────────────────────────────────

function renderOnboardingSafety() {
  const text = state.settings.onboarding_text || '';
  return `
    <div class="screen">
      <div class="onboard-header">
        <div class="onboard-icon">🌿</div>
        <div class="onboard-title">体調の隠れ相関発見ノート</div>
      </div>
      <div class="card mt-12">
        <div class="onboard-body">${escHtml(text)}</div>
      </div>
      <div class="notice">
        このツールは医療の代替にはなりません。<br>
        気になる症状があれば、専門家にご相談ください。
      </div>
      <div class="mt-12">
        <button class="btn btn-primary btn-full" data-action="onboard-next">
          理解しました。記録を始める
        </button>
      </div>
    </div>
  `;
}

function renderOnboardingMetrics() {
  const metrics = state.metrics;
  const symptoms = metrics.filter(m => m.role === 'symptom');
  const factors  = metrics.filter(m => m.role === 'factor');
  const maxM = state.settings.max_metrics || 6;
  const count = metrics.length;

  return `
    <div class="screen">
      <div class="screen-title">記録する項目を設定</div>
      <p class="text-muted" style="margin-bottom:12px;line-height:1.6">
        症状（追いたい体の不調）と要因（関係しそうな生活習慣）を登録します。<br>
        最初は 3〜4 個を推奨します（上限 ${maxM} 個）。
      </p>

      ${symptoms.length ? `
        <div class="screen-title" style="font-size:0.85rem;margin-bottom:6px">症状</div>
        ${symptoms.map(m => renderMetricChip(m)).join('')}
      ` : ''}
      ${factors.length ? `
        <div class="screen-title" style="font-size:0.85rem;margin-bottom:6px;margin-top:12px">要因</div>
        ${factors.map(m => renderMetricChip(m)).join('')}
      ` : ''}

      ${count < maxM ? `
        <div class="card mt-12">
          <div class="screen-title" style="font-size:0.9rem;margin-bottom:10px">項目を追加</div>
          <div class="form-group">
            <label class="form-label">名前</label>
            <input class="form-input" id="new-metric-name" type="text" placeholder="例: 頭痛、睡眠時間" value="${escHtml(state.newMetric.name)}">
          </div>
          <div class="form-group">
            <label class="form-label">種類</label>
            <div class="chip-group">
              <button class="chip ${state.newMetric.role === 'symptom' ? 'selected' : ''}" data-action="set-role" data-val="symptom">症状</button>
              <button class="chip ${state.newMetric.role === 'factor'  ? 'selected' : ''}" data-action="set-role" data-val="factor">要因</button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">入力形式</label>
            <div class="chip-group" style="flex-wrap:wrap">
              <button class="chip ${state.newMetric.dtype === 'binary'     ? 'selected' : ''}" data-action="set-dtype" data-val="binary">あり/なし</button>
              <button class="chip ${state.newMetric.dtype === 'continuous' ? 'selected' : ''}" data-action="set-dtype" data-val="continuous">数値(0-10)</button>
            </div>
          </div>
          <button class="btn btn-secondary btn-full btn-sm" data-action="add-metric">追加する</button>
        </div>
      ` : `<div class="notice mt-12">項目数の上限（${maxM}件）に達しています。</div>`}

      <div class="mt-12">
        ${metrics.length >= 2 ? `
          <button class="btn btn-primary btn-full" data-action="onboard-complete">
            記録を開始する
          </button>
        ` : `
          <p class="text-muted" style="text-align:center">症状と要因を1つずつ以上追加してください</p>
        `}
      </div>
    </div>
  `;
}

function renderMetricChip(m) {
  const roleLabel = m.role === 'symptom' ? '症状' : '要因';
  const dtypeLabel = { binary: 'あり/なし', continuous: '数値', category: 'タグ' }[m.dtype] || m.dtype;
  return `
    <div class="card" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;margin-bottom:6px">
      <div>
        <span style="font-weight:600">${escHtml(m.name)}</span>
        <span class="metric-role-badge">${roleLabel} · ${dtypeLabel}</span>
      </div>
      <button class="btn btn-sm" style="padding:6px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text-muted);border-radius:6px"
              data-action="archive-metric" data-id="${m.id}">削除</button>
    </div>
  `;
}

// ── 今日の記録 ──────────────────────────────────────────────────────────────

function renderRecord() {
  const d = state.todayData;
  if (!d) return `<div class="screen"><div class="loading">読み込み中...</div></div>` + renderNav('record');

  if (d.paused) {
    return `
      <div class="screen">
        <div class="screen-title">記録</div>
        <div class="empty-state">
          <div class="empty-icon">⏸</div>
          <div class="empty-text">記録は一時停止中です。<br>設定から再開できます。</div>
        </div>
      </div>
      ${renderNav('record')}
    `;
  }

  const metrics = d.metrics || [];
  const existing = d.existing_values || {};

  // 保存済みの値か state.formValues の値を使う
  for (const m of metrics) {
    if (!(m.id in state.formValues)) {
      state.formValues[m.id] = existing[m.id] ?? null;
    }
  }

  const symptoms = metrics.filter(m => m.role === 'symptom');
  const factors  = metrics.filter(m => m.role === 'factor');

  if (!metrics.length) {
    return `
      <div class="screen">
        <div class="screen-title">今日の記録</div>
        <div class="empty-state">
          <div class="empty-icon">📝</div>
          <div class="empty-text">記録項目がありません。<br>設定から項目を追加してください。</div>
        </div>
      </div>
      ${renderNav('record')}
    `;
  }

  const savedToday = Object.keys(existing).length > 0;

  return `
    <div class="screen">
      <div class="screen-title">今日の記録 <span class="text-muted" style="font-size:0.8rem;font-weight:400">${d.date}</span></div>

      ${d.severe_warning ? `<div class="notice" style="margin-bottom:12px">${escHtml(d.severe_warning)}</div>` : ''}

      <div class="card">
        ${symptoms.length ? `
          <div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">症状</div>
          ${symptoms.map(m => renderMetricInput(m)).join('')}
        ` : ''}
        ${factors.length ? `
          <div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);margin-top:${symptoms.length?'16px':'0'};margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">要因</div>
          ${factors.map(m => renderMetricInput(m)).join('')}
        ` : ''}
      </div>

      <button class="btn btn-primary btn-full" data-action="save-record" style="margin-top:4px">
        ${savedToday ? '更新する' : '保存する'}
      </button>
      ${savedToday ? '<p class="text-muted mt-8" style="text-align:center;font-size:0.8rem">今日は記録済みです</p>' : ''}
    </div>
    ${renderNav('record')}
  `;
}

function renderMetricInput(m) {
  const val = state.formValues[m.id];
  if (m.dtype === 'binary') {
    return `
      <div class="metric-row">
        <div class="metric-label">${escHtml(m.name)}</div>
        <div class="binary-btns">
          <button class="binary-btn ${val === 1 ? 'selected-yes' : ''}" data-action="set-binary" data-id="${m.id}" data-val="1">あり</button>
          <button class="binary-btn ${val === 0 ? 'selected-no'  : ''}" data-action="set-binary" data-id="${m.id}" data-val="0">なし</button>
        </div>
      </div>
    `;
  }
  if (m.dtype === 'continuous') {
    const v = val !== null && val !== undefined ? val : 5;
    return `
      <div class="metric-row">
        <div class="metric-label">${escHtml(m.name)}</div>
        <div class="slider-wrap">
          <span style="color:var(--text-muted);font-size:0.8rem">0</span>
          <input type="range" min="0" max="10" step="0.5" value="${v}"
                 data-action="set-continuous" data-id="${m.id}">
          <span class="slider-val" id="sv-${m.id}">${v}</span>
          <span style="color:var(--text-muted);font-size:0.8rem">10</span>
        </div>
      </div>
    `;
  }
  return '';
}

// ── 気づき ──────────────────────────────────────────────────────────────────

function renderInsights() {
  const insights = state.insights;
  const noData = !state.todayData || (state.todayData.metrics || []).length === 0;

  let content;
  if (noData) {
    content = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-text">記録項目を設定すると、<br>ここに気づきが届きます。</div>
      </div>
    `;
  } else if (!insights.length) {
    content = `
      <div class="empty-state">
        <div class="empty-icon">🌱</div>
        <div class="empty-text">今はまだ目立った関連は見つかっていません。<br><br>記録を続けると、少しずつデータが増えていきます。<br>データが14日分以上になると分析が始まります。<br><br>気づきがないことは、正常な結果です。</div>
      </div>
    `;
  } else {
    content = insights.map(ins => `
      <div class="card insight-card">
        <span class="strength-badge strength-${ins.strength}">
          ${ins.strength === 'clear' ? 'はっきり' : 'ややあり'}
        </span>
        <div class="insight-text">${escHtml(ins.text)}</div>
        <div class="insight-disclaimer">${escHtml(ins.disclaimer)}</div>
        <div class="insight-actions">
          ${ins.can_experiment ? `<button class="btn btn-secondary btn-sm" data-action="start-experiment" data-id="${ins.id}">試してみる</button>` : ''}
          <button class="btn btn-sm" style="border:1px solid var(--border);background:var(--bg);color:var(--text-muted)" data-action="dismiss-insight" data-id="${ins.id}">閉じる</button>
        </div>
      </div>
    `).join('');
  }

  return `
    <div class="screen">
      <div class="screen-title">気づき</div>
      ${content}
    </div>
    ${renderNav('insights')}
  `;
}

// ── 検証実験 ─────────────────────────────────────────────────────────────────

function renderExperiments() {
  const exps = state.experiments;
  let content;
  if (!exps.length) {
    content = `
      <div class="empty-state">
        <div class="empty-icon">🧪</div>
        <div class="empty-text">気づきカードから「試してみる」を選ぶと、<br>ここに実験が表示されます。</div>
      </div>
    `;
  } else {
    content = exps.map(exp => {
      const done = !!exp.end_date;
      return `
        <div class="card experiment-card">
          <div class="exp-row">
            <div class="exp-label">介入内容</div>
            <div class="exp-value">${escHtml(exp.intervention)}</div>
          </div>
          <div class="exp-row">
            <div class="exp-label">開始日</div>
            <div class="exp-value">${exp.start_date}</div>
          </div>
          ${done ? `
            <div class="exp-row">
              <div class="exp-label">終了日</div>
              <div class="exp-value">${exp.end_date}</div>
            </div>
            <div class="exp-conclusion">${escHtml(exp.conclusion || '')}</div>
          ` : `
            <div class="notice">実験中です。3日後に結果が表示されます。</div>
          `}
        </div>
      `;
    }).join('');
  }

  return `
    <div class="screen">
      <div class="screen-title">検証実験</div>
      ${content}
    </div>
    ${renderNav('experiments')}
  `;
}

// ── 設定 ────────────────────────────────────────────────────────────────────

function renderSettings() {
  const s = state.settings;
  const paused = !!s.paused;
  const sensitivity = s.sensitivity || 'conservative';

  return `
    <div class="screen">
      <div class="screen-title">設定</div>

      <div class="card">
        <div class="toggle-row">
          <div>
            <div class="toggle-label">記録を一時停止</div>
            <div class="toggle-desc">通知・走査も停止します（SAFE-6）</div>
          </div>
          <label class="toggle">
            <input type="checkbox" ${paused ? 'checked' : ''} data-action="toggle-pause">
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="toggle-row">
          <div>
            <div class="toggle-label">分析感度</div>
            <div class="toggle-desc">「控えめ」は誤発見を減らします（推奨）</div>
          </div>
          <div class="chip-group">
            <button class="chip btn-sm ${sensitivity === 'conservative' ? 'selected' : ''}"
                    data-action="set-sensitivity" data-val="conservative">控えめ</button>
            <button class="chip btn-sm ${sensitivity === 'standard' ? 'selected' : ''}"
                    data-action="set-sensitivity" data-val="standard">標準</button>
          </div>
        </div>
      </div>

      <div class="card mt-12">
        <div class="screen-title" style="font-size:0.9rem;margin-bottom:10px">記録項目を管理</div>
        ${(state.todayData?.metrics || []).map(m => renderMetricChip(m)).join('') || '<p class="text-muted">項目がありません</p>'}

        ${(state.settings.active_metric_count || 0) < (state.settings.max_metrics || 6) ? `
          <button class="btn btn-secondary btn-full btn-sm" style="margin-top:10px" data-action="add-metric-flow">
            項目を追加する
          </button>
        ` : ''}
      </div>

      <div class="card mt-12">
        <div class="screen-title" style="font-size:0.9rem;margin-bottom:10px">データ</div>
        <button class="btn btn-secondary btn-full btn-sm" data-action="export-data">
          データをエクスポート（JSON）
        </button>
        <div class="mt-8">
          <button class="btn btn-full btn-sm" style="border:1px solid var(--danger);color:var(--danger);background:var(--danger-light)"
                  data-action="delete-all">
            全データを削除する
          </button>
        </div>
        <p class="text-muted mt-8" style="font-size:0.78rem;line-height:1.6">
          削除すると元に戻せません。記録が負担なら、削除より一時停止をおすすめします。
        </p>
      </div>

      <div class="card mt-12">
        <div style="font-size:0.8rem;color:var(--text-muted);line-height:1.7">
          本ツールは医療機器でも診断ツールでもありません。<br>
          気になる症状は医療機関にご相談ください。<br>
          <br>
          体調の隠れ相関発見ノート v0.1
        </div>
      </div>
    </div>
    ${renderNav('settings')}
  `;
}

// ── ボトムナビ ──────────────────────────────────────────────────────────────

function renderNav(active) {
  const tabs = [
    { id: 'record',      icon: '📝', label: '記録' },
    { id: 'insights',    icon: '💡', label: '気づき' },
    { id: 'experiments', icon: '🧪', label: '実験' },
    { id: 'settings',    icon: '⚙️', label: '設定' },
  ];
  return `
    <nav class="bottom-nav">
      ${tabs.map(t => `
        <button class="nav-btn ${active === t.id ? 'active' : ''}" data-action="nav" data-screen="${t.id}">
          <span class="nav-icon">${t.icon}</span>
          <span>${t.label}</span>
        </button>
      `).join('')}
    </nav>
  `;
}

// ── イベント処理 ─────────────────────────────────────────────────────────────

function attachListeners() {
  document.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', handleAction);
  });
  document.querySelectorAll('input[type=range]').forEach(el => {
    el.addEventListener('input', handleSlider);
  });
  document.querySelectorAll('#new-metric-name').forEach(el => {
    el.addEventListener('input', e => { state.newMetric.name = e.target.value; });
  });
}

async function handleAction(e) {
  const el = e.currentTarget;
  const action = el.dataset.action;

  switch (action) {
    case 'nav':
      await navigateTo(el.dataset.screen);
      break;

    case 'onboard-next':
      state.screen = 'onboarding-metrics';
      render();
      break;

    case 'onboard-complete':
      await api.patch('/settings', { onboarded: 1 });
      state.settings.onboarded = 1;
      await loadRecord();
      state.screen = 'record';
      render();
      break;

    case 'set-role':
      state.newMetric.role = el.dataset.val;
      render();
      break;

    case 'set-dtype':
      state.newMetric.dtype = el.dataset.val;
      render();
      break;

    case 'add-metric': {
      const nameInput = document.getElementById('new-metric-name');
      const name = nameInput ? nameInput.value.trim() : state.newMetric.name.trim();
      if (!name) { alert('名前を入力してください'); return; }
      try {
        const m = await api.post('/metrics', {
          name, role: state.newMetric.role, dtype: state.newMetric.dtype,
        });
        state.metrics.push(m);
        state.newMetric.name = '';
        render();
      } catch (err) {
        alert(err.message);
      }
      break;
    }

    case 'add-metric-flow':
      state.screen = 'onboarding-metrics';
      render();
      break;

    case 'archive-metric':
      if (!confirm('この項目を削除しますか？過去の記録は残ります。')) return;
      await api.patch(`/metrics/${el.dataset.id}`, { archived: 1 });
      state.metrics = state.metrics.filter(m => m.id != el.dataset.id);
      if (state.todayData) {
        state.todayData.metrics = state.todayData.metrics.filter(m => m.id != el.dataset.id);
      }
      await reloadSettings();
      render();
      break;

    case 'set-binary':
      state.formValues[el.dataset.id] = Number(el.dataset.val);
      render();
      break;

    case 'save-record': {
      const entries = Object.entries(state.formValues)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([id, value]) => ({ metric_id: Number(id), value }));
      if (!entries.length) { alert('何か入力してください'); return; }
      try {
        await api.post('/entries', { entries });
        await loadRecord();
        render();
        showToast('記録しました');
      } catch (err) {
        alert(err.message);
      }
      break;
    }

    case 'dismiss-insight':
      await api.post(`/insights/${el.dataset.id}/dismiss`, {});
      state.insights = state.insights.filter(i => i.id != el.dataset.id);
      render();
      break;

    case 'start-experiment':
      try {
        const exp = await api.post(`/insights/${el.dataset.id}/experiment`, {});
        showToast('実験を開始しました');
        state.insights = state.insights.map(i =>
          i.id == el.dataset.id ? { ...i, can_experiment: false } : i
        );
        await loadExperiments();
        render();
      } catch (err) {
        alert(err.message);
      }
      break;

    case 'toggle-pause':
      const result = await api.post('/pause', {});
      state.settings.paused = result.paused ? 1 : 0;
      await reloadSettings();
      render();
      break;

    case 'set-sensitivity':
      await api.patch('/settings', { sensitivity: el.dataset.val });
      state.settings.sensitivity = el.dataset.val;
      render();
      break;

    case 'export-data': {
      const data = await api.get('/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'health_export.json'; a.click();
      URL.revokeObjectURL(url);
      break;
    }

    case 'delete-all':
      if (!confirm('全データを削除します。この操作は元に戻せません。\n\n本当に削除しますか？')) return;
      if (!confirm('最終確認：全データを削除してよろしいですか？')) return;
      await api.delete('/data?confirm=true');
      state.settings = {};
      state.metrics = [];
      state.todayData = null;
      state.insights = [];
      state.formValues = {};
      await init();
      break;
  }
}

function handleSlider(e) {
  const id = e.target.dataset.id;
  const val = parseFloat(e.target.value);
  state.formValues[id] = val;
  const display = document.getElementById(`sv-${id}`);
  if (display) display.textContent = val;
}

async function navigateTo(screen) {
  state.screen = screen;
  if (screen === 'record') await loadRecord();
  if (screen === 'insights') await loadInsights();
  if (screen === 'experiments') await loadExperiments();
  if (screen === 'settings') await reloadSettings();
  render();
}

// ── データロード ─────────────────────────────────────────────────────────────

async function loadRecord() {
  state.todayData = await api.get('/today');
  state.metrics = state.todayData.metrics || [];
  state.formValues = {};
  const existing = state.todayData.existing_values || {};
  for (const m of state.metrics) {
    state.formValues[m.id] = existing[m.id] ?? null;
  }
}

async function loadInsights() {
  state.insights = await api.get('/insights');
}

async function loadExperiments() {
  state.experiments = await api.get('/experiments');
}

async function reloadSettings() {
  state.settings = await api.get('/settings');
}

// ── トースト ─────────────────────────────────────────────────────────────────

function showToast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed', bottom: '80px', left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(0,0,0,0.75)', color: '#fff',
    padding: '10px 20px', borderRadius: '20px',
    fontSize: '0.9rem', zIndex: '9999',
    whiteSpace: 'nowrap',
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

// ── ユーティリティ ────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

// ── 初期化 ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    state.settings = await api.get('/settings');
    if (!state.settings.onboarded) {
      state.metrics = await api.get('/metrics');
      state.screen = 'onboarding-safety';
    } else {
      await loadRecord();
      await loadInsights();
      state.screen = 'record';
    }
  } catch (err) {
    document.getElementById('app').innerHTML = `
      <div class="screen" style="padding-top:40px">
        <div class="onboard-header">
          <div class="onboard-icon">🌿</div>
          <div class="onboard-title">体調の隠れ相関発見ノート</div>
        </div>
        <div class="card mt-12">
          <div class="onboard-body">1日10秒の記録から、体調の不調と生活習慣の隠れた関連を自動で発見するツールです。\n\n症状（頭痛・疲労感など）と要因（睡眠・食事など）を毎日記録するだけで、統計的な相関を自動分析します。</div>
        </div>
        <div class="notice mt-12">
          このページはデモ表示です。<br>
          実際に使用するにはバックエンドサーバーが必要です。<br><br>
          <strong>ローカルで起動：</strong><br>
          git clone して <code style="background:#fff3;padding:2px 6px;border-radius:4px">python run.py</code> を実行してください。
        </div>
        <div class="card mt-12">
          <div style="font-size:0.8rem;color:var(--text-muted);line-height:1.7">
            本ツールは医療機器でも診断ツールでもありません。<br>
            気になる症状は医療機関にご相談ください。<br><br>
            体調の隠れ相関発見ノート v0.1
          </div>
        </div>
      </div>
    `;
    return;
  }
  render();
}

init();
