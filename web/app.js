// app.js — 体調の隠れ相関発見ノート (localStorage版)

// ── 定数 ─────────────────────────────────────────────────────────────────────

const MAX_METRICS = 6;
const DISCLAIMER  = '※これは関連であって、原因とは限りません。';

const ONBOARDING_TEXT =
  "このツールについて\n\n" +
  "● 本ツールは医療機器でも診断ツールでもなく、医療の代替にはなりません。\n" +
  "  気になる症状は、専門家（医師・医療機関）にご相談ください。\n\n" +
  "● 記録が負担に感じたら、いつでも中断してかまいません。\n" +
  "  記録をやめたほうが体調がよくなる場合もあります。\n\n" +
  "● 本ツールが見つけた「関連」は、原因ではありません。\n" +
  "  あくまで参考として、穏やかに受け取ってください。\n\n" +
  "記録項目は3〜4個を推奨します（上限6個）。\n" +
  "少ない項目で始めることをおすすめします。";

const SEVERE_SYMPTOM_MESSAGE =
  "最近、強いつらさが続いているようです。" +
  "体調が心配な場合は、医療機関への相談をご検討ください。" +
  "本ツールの記録を中断することも、いつでもできます（設定→一時停止）。";

const THRESHOLDS = {
  conservative: { n_min:5, d_min:0.5, lift_min:1.5, min_days:14 },
  standard:     { n_min:4, d_min:0.4, lift_min:1.3, min_days:14 },
};

// ── ユーティリティ ────────────────────────────────────────────────────────────

function todayStr() { return new Date().toISOString().slice(0, 10); }

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/\n/g,'<br>');
}

// ── DB (localStorage) ─────────────────────────────────────────────────────────

const KEYS = {
  settings:'hc_settings', metrics:'hc_metrics', entries:'hc_entries',
  autoFactors:'hc_auto_factors', insights:'hc_insights', experiments:'hc_experiments',
};

const db = {
  _load(key, def) {
    try { const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) : def; }
    catch { return def; }
  },
  _save(key, val) { localStorage.setItem(key, JSON.stringify(val)); },

  getSettings() {
    const s = { onboarded:0, sensitivity:'conservative', paused:0, last_scan:null,
                ...this._load(KEYS.settings, {}) };
    return { ...s, onboarding_text:ONBOARDING_TEXT, max_metrics:MAX_METRICS,
             active_metric_count:this.getActiveMetrics().length };
  },
  updateSettings(patch) {
    const cur = this._load(KEYS.settings, {});
    const { onboarding_text, max_metrics, active_metric_count, ...bare } = { ...cur, ...patch };
    this._save(KEYS.settings, bare);
    return this.getSettings();
  },

  getMetrics()       { return this._load(KEYS.metrics, []); },
  getActiveMetrics() { return this.getMetrics().filter(m => !m.archived); },
  addMetric(name, role, dtype) {
    if (this.getActiveMetrics().length >= MAX_METRICS) return null;
    const m = { id:Date.now(), name, role, dtype, archived:0, created_at:new Date().toISOString() };
    this._save(KEYS.metrics, [...this.getMetrics(), m]);
    return m;
  },
  archiveMetric(id) {
    this._save(KEYS.metrics, this.getMetrics().map(m => m.id==id ? {...m,archived:1} : m));
  },

  getEntries() { return this._load(KEYS.entries, []); },
  getTodayExisting() {
    const map = {};
    for (const e of this.getEntries().filter(e => e.date===todayStr())) map[e.metric_id] = e.value;
    return map;
  },
  saveEntries(date, items) {
    let entries = this.getEntries();
    for (const item of items) {
      const idx = entries.findIndex(e => e.date===date && e.metric_id==item.metric_id);
      if (idx >= 0) entries[idx] = {...entries[idx], value:item.value};
      else entries.push({ id:Date.now()+Math.random(), date, metric_id:item.metric_id, value:item.value });
    }
    this._save(KEYS.entries, entries);
    this._ensureAutoFactor(date);
  },
  _ensureAutoFactor(date) {
    const afs = this._load(KEYS.autoFactors, []);
    if (!afs.find(a => a.date===date)) {
      const j = new Date(date).getDay();
      afs.push({ date, weekday: j===0?6:j-1 });
      this._save(KEYS.autoFactors, afs);
    }
  },

  _getAllInsights()    { return this._load(KEYS.insights, []); },
  getActiveInsights() { return this._getAllInsights().filter(i => !i.dismissed); },
  getInsightsForUI() {
    return this.getActiveInsights().map(i => {
      const parts = (i.text||'').split('\n');
      return { ...i, text:parts[0], disclaimer:parts.slice(1).join('\n'),
               can_experiment:!this.hasExperimentForInsight(i.id) };
    });
  },
  saveInsights(insights) { this._save(KEYS.insights, insights); },
  dismissInsight(id) {
    this._save(KEYS.insights, this._getAllInsights().map(i => i.id==id ? {...i,dismissed:1} : i));
  },

  hasExperimentForInsight(id) { return this.getExperimentsRaw().some(e => e.insight_id==id); },
  getExperimentsRaw() { return this._load(KEYS.experiments, []); },
  getExperimentsForUI() {
    const exps = this.getExperimentsRaw();
    const today = todayStr();
    let changed = false;
    for (const exp of exps) {
      if (!exp.end_date && exp.start_date) {
        const diff = Math.floor((new Date(today) - new Date(exp.start_date)) / 86400000);
        if (diff >= 3) {
          const ins = this._getAllInsights().find(i => i.id==exp.insight_id);
          if (ins) {
            const vals = this.getEntries()
              .filter(e => e.metric_id==ins.symptom_id && e.date>=exp.start_date && e.date<=today && e.value!==null)
              .map(e => e.value);
            const afterRate = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
            exp.end_date=today; exp.after_rate=afterRate;
            exp.conclusion=buildExperimentConclusion(exp.before_rate||0, afterRate);
            changed=true;
          }
        }
      }
    }
    if (changed) this._save(KEYS.experiments, exps);
    return [...exps].reverse();
  },
  addExperiment(exp) { this._save(KEYS.experiments, [...this.getExperimentsRaw(), exp]); },
  deleteAll() { Object.values(KEYS).forEach(k => localStorage.removeItem(k)); },
};

// ── 統計関数 (correlate.py 移植) ─────────────────────────────────────────────

function _mean(a)   { return a.reduce((s,x)=>s+x,0)/a.length; }
function _pstdev(a) { const m=_mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/a.length); }

function cohensD(a, b) {
  if (a.length<2||b.length<2) return null;
  const pv = ((a.length-1)*_pstdev(a)**2+(b.length-1)*_pstdev(b)**2)/(a.length+b.length-2);
  return pv<=0 ? null : (_mean(a)-_mean(b))/Math.sqrt(pv);
}

function liftValue(n11,n10,n01,n00) {
  const t=n11+n10+n01+n00; if(!t) return null;
  const d=((n11+n10)/t)*((n11+n01)/t); return d?(n11/t)/d:null;
}

function _rankData(d) {
  const n=d.length, idx=[...Array(n).keys()].sort((a,b)=>d[a]-d[b]), r=new Array(n).fill(0);
  let i=0;
  while(i<n){let j=i;while(j<n-1&&d[idx[j+1]]===d[idx[i]])j++;const avg=(i+j)/2+1;for(let k=i;k<=j;k++)r[idx[k]]=avg;i=j+1;}
  return r;
}

function spearmanRho(xs,ys) {
  const n=xs.length; if(n<4) return null;
  const rx=_rankData(xs),ry=_rankData(ys),d2=rx.reduce((s,r,i)=>s+(r-ry[i])**2,0),dn=n*(n**2-1);
  return dn?1-6*d2/dn:null;
}

function _strength(d,lft) {
  const ad=d!==null?Math.abs(d):0,lv=lft??0;
  return(ad>=0.8||lv>=2.0)?'clear':(ad>=0.5||lv>=1.5)?'mild':null;
}

function _evalPair(sv,fv,sd,fd,cfg) {
  const {n_min,d_min,lift_min}=cfg;
  if(sd==='binary'&&fd==='continuous'){
    const w=fv.filter((_,i)=>sv[i]===1),wo=fv.filter((_,i)=>sv[i]===0);
    if(w.length<n_min||wo.length<n_min)return null;
    const d=cohensD(w,wo);if(d===null||Math.abs(d)<d_min)return null;
    const s=_strength(d,null);if(!s)return null;
    return{effect:d,effect_type:'cohens_d',strength:s,direction_positive:d>0,n_pos:w.length,n_neg:wo.length};
  }
  if(sd==='binary'&&(fd==='binary'||fd==='category')){
    let n11=0,n10=0,n01=0,n00=0;
    for(let i=0;i<sv.length;i++){if(sv[i]===1&&fv[i]===1)n11++;else if(sv[i]===1&&fv[i]===0)n10++;else if(sv[i]===0&&fv[i]===1)n01++;else n00++;}
    if(n11<n_min||(n10+n00)<n_min)return null;
    const lft=liftValue(n11,n10,n01,n00);if(lft===null||lft<lift_min)return null;
    const s=_strength(null,lft);if(!s)return null;
    return{effect:lft,effect_type:'lift',strength:s,direction_positive:true,n_pos:n11,n_neg:n10+n00};
  }
  if(sd==='continuous'&&fd==='continuous'){
    if(sv.length<4)return null;
    const rho=spearmanRho(sv,fv);if(rho===null||Math.abs(rho)<d_min)return null;
    const s=_strength(rho,null);if(!s)return null;
    return{effect:rho,effect_type:'spearman',strength:s,direction_positive:rho>0,n_pos:sv.length,n_neg:0};
  }
  if(sd==='continuous'&&(fd==='binary'||fd==='category')){
    const g1=sv.filter((_,i)=>fv[i]===1),g0=sv.filter((_,i)=>fv[i]===0);
    if(g1.length<n_min||g0.length<n_min)return null;
    const d=cohensD(g1,g0);if(d===null||Math.abs(d)<d_min)return null;
    const s=_strength(d,null);if(!s)return null;
    return{effect:d,effect_type:'cohens_d',strength:s,direction_positive:d>0,n_pos:g1.length,n_neg:g0.length};
  }
  return null;
}

function _scanPair(rows,sk,fk,sd,fd,cfg){
  let best=null;
  for(const lag of[0,1,2]){
    const sv=[],fv=[];
    for(let i=lag;i<rows.length;i++){const s=rows[i][sk],f=rows[i-lag][fk];if(s==null||f==null)continue;sv.push(s);fv.push(f);}
    const r=_evalPair(sv,fv,sd,fd,cfg);
    if(r&&(!best||Math.abs(r.effect)>Math.abs(best.effect)))best={...r,lag};
  }
  return best;
}

function runFullScan(){
  const settings=db.getSettings();
  if(settings.paused||settings.last_scan===todayStr())return 0;
  const cfg=THRESHOLDS[settings.sensitivity]||THRESHOLDS.conservative;
  const entries=db.getEntries();
  if(new Set(entries.map(e=>e.date)).size<cfg.min_days)return 0;
  const metrics=db.getActiveMetrics();
  const symptoms=metrics.filter(m=>m.role==='symptom'),factors=metrics.filter(m=>m.role==='factor');
  if(!symptoms.length||!factors.length)return 0;

  const daily={};
  for(const e of entries){if(!daily[e.date])daily[e.date]={};daily[e.date][`m_${e.metric_id}`]=e.value;}
  for(const a of db._load(KEYS.autoFactors,[])){if(!daily[a.date])daily[a.date]={};daily[a.date]['auto_weekday']=a.weekday;}
  const dl=Object.keys(daily).sort().map(d=>daily[d]);

  const results=[];
  for(const sym of symptoms){
    const sk=`m_${sym.id}`;
    for(const fac of factors){
      const r=_scanPair(dl,sk,`m_${fac.id}`,sym.dtype,fac.dtype,cfg);
      if(r)results.push({symptom_id:sym.id,symptom_name:sym.name,factor_ref:String(fac.id),factor_name:fac.name,factor_dtype:fac.dtype,sym_dtype:sym.dtype,...r});
    }
    const r=_scanPair(dl,sk,'auto_weekday',sym.dtype,'continuous',cfg);
    if(r)results.push({symptom_id:sym.id,symptom_name:sym.name,factor_ref:'auto_weekday',factor_name:'曜日',factor_dtype:'continuous',sym_dtype:sym.dtype,...r});
  }
  results.sort((a,b)=>Math.abs(b.effect)-Math.abs(a.effect));
  const top=results.slice(0,2);

  const dismissed=db._getAllInsights().filter(i=>i.dismissed);
  const newInsights=[...dismissed];
  for(const r of top){
    const[,full]=buildText(r.symptom_name,r.factor_name,r.lag,r.direction_positive,r.strength,r.factor_dtype);
    newInsights.push({id:Date.now()+Math.random(),symptom_id:r.symptom_id,factor_ref:r.factor_ref,
      lag:r.lag,effect:r.effect,strength:r.strength,text:full,dismissed:0,detected_at:new Date().toISOString()});
  }
  db.saveInsights(newInsights);
  db.updateSettings({last_scan:todayStr()});
  return top.length;
}

// ── 言語化 (verbalize.py 移植) ───────────────────────────────────────────────

function buildText(sName,fName,lag,dirPos,strength,fDtype){
  const ls=['','前日の','一昨日の'][lag]??'';
  const ss=strength==='clear'?'はっきり':'ややあり';
  const dw=(fDtype==='binary'||fDtype==='category')?(dirPos?'ある日が多め':'ない日が多め'):(dirPos?'多め':'少なめ');
  const body=(fDtype==='binary'||fDtype==='category')
    ?`${sName}が出た日は、${ls}${fName}が${dw}傾向があります（${ss}）。`
    :`${sName}が出た日は、${ls}${fName}が普段より${dw}傾向があります（${ss}）。`;
  return[body,body+'\n'+DISCLAIMER];
}

function buildExperimentProposal(fName,dirPos){
  return dirPos?`3日間だけ、${fName}を意識して少し減らしてみましょう（無理のない範囲で）。`
               :`3日間だけ、${fName}を意識して少し増やしてみましょう（無理のない範囲で）。`;
}

function buildExperimentConclusion(before,after){
  const d=after-before;
  return Math.abs(d)<0.05?'実験の前後で、はっきりした変化は見られませんでした。'
    :d<0?'実験後、症状の頻度がやや下がる傾向が見られました。引き続き様子を見てみましょう。'
        :'実験後、症状の頻度に変化が見られました。別の要因も関係しているかもしれません。';
}

// ── 安全チェック ──────────────────────────────────────────────────────────────

function checkSevereSymptoms(metricId){
  const rows=db.getEntries().filter(e=>e.metric_id==metricId).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,7);
  return rows.length>=7&&rows.every(r=>r.value===1);
}

function getFactorName(factorRef){
  if(factorRef==='auto_weekday')return '曜日';
  const m=db.getMetrics().find(m=>String(m.id)===String(factorRef));
  return m?m.name:factorRef;
}

// ── アプリ状態 ──────────────────────────────────────────────────────────────

const state = {
  screen: 'loading',
  settings: {},
  todayData: null,
  metrics: [],
  formValues: {},
  insights: [],
  experiments: [],
  newMetric: { name:'', role:'symptom', dtype:'binary' },
};

// ── レンダリング ────────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app');
  switch (state.screen) {
    case 'loading':           app.innerHTML = `<div class="loading">読み込み中...</div>`; break;
    case 'onboarding-safety': app.innerHTML = renderOnboardingSafety(); break;
    case 'onboarding-metrics':app.innerHTML = renderOnboardingMetrics(); break;
    case 'record':            app.innerHTML = renderRecord(); break;
    case 'insights':          app.innerHTML = renderInsights(); break;
    case 'experiments':       app.innerHTML = renderExperiments(); break;
    case 'settings':          app.innerHTML = renderSettings(); break;
  }
  attachListeners();
}

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
  const dtypeLabel = { binary:'あり/なし', continuous:'数値', category:'タグ' }[m.dtype] || m.dtype;
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
  for (const m of metrics) {
    if (!(m.id in state.formValues)) state.formValues[m.id] = existing[m.id] ?? null;
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

function renderInsights() {
  const insights = state.insights;
  const noData = !state.todayData || (state.todayData.metrics || []).length === 0;

  let content;
  if (noData) {
    content = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">記録項目を設定すると、<br>ここに気づきが届きます。</div></div>`;
  } else if (!insights.length) {
    content = `<div class="empty-state"><div class="empty-icon">🌱</div><div class="empty-text">今はまだ目立った関連は見つかっていません。<br><br>記録を続けると、少しずつデータが増えていきます。<br>データが14日分以上になると分析が始まります。<br><br>気づきがないことは、正常な結果です。</div></div>`;
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
    <div class="screen"><div class="screen-title">気づき</div>${content}</div>
    ${renderNav('insights')}
  `;
}

function renderExperiments() {
  const exps = state.experiments;
  let content;
  if (!exps.length) {
    content = `<div class="empty-state"><div class="empty-icon">🧪</div><div class="empty-text">気づきカードから「試してみる」を選ぶと、<br>ここに実験が表示されます。</div></div>`;
  } else {
    content = exps.map(exp => {
      const done = !!exp.end_date;
      return `
        <div class="card experiment-card">
          <div class="exp-row"><div class="exp-label">介入内容</div><div class="exp-value">${escHtml(exp.intervention)}</div></div>
          <div class="exp-row"><div class="exp-label">開始日</div><div class="exp-value">${exp.start_date}</div></div>
          ${done ? `
            <div class="exp-row"><div class="exp-label">終了日</div><div class="exp-value">${exp.end_date}</div></div>
            <div class="exp-conclusion">${escHtml(exp.conclusion||'')}</div>
          ` : `<div class="notice">実験中です。3日後に結果が表示されます。</div>`}
        </div>
      `;
    }).join('');
  }
  return `<div class="screen"><div class="screen-title">検証実験</div>${content}</div>${renderNav('experiments')}`;
}

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
            <div class="toggle-desc">通知・走査も停止します</div>
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
            <button class="chip btn-sm ${sensitivity==='conservative'?'selected':''}" data-action="set-sensitivity" data-val="conservative">控えめ</button>
            <button class="chip btn-sm ${sensitivity==='standard'?'selected':''}" data-action="set-sensitivity" data-val="standard">標準</button>
          </div>
        </div>
      </div>

      <div class="card mt-12">
        <div class="screen-title" style="font-size:0.9rem;margin-bottom:10px">記録項目を管理</div>
        ${(state.todayData?.metrics || []).map(m => renderMetricChip(m)).join('') || '<p class="text-muted">項目がありません</p>'}
        ${(s.active_metric_count||0)<(s.max_metrics||6) ? `
          <button class="btn btn-secondary btn-full btn-sm" style="margin-top:10px" data-action="add-metric-flow">項目を追加する</button>
        ` : ''}
      </div>

      <div class="card mt-12">
        <div class="screen-title" style="font-size:0.9rem;margin-bottom:10px">データ</div>
        <button class="btn btn-secondary btn-full btn-sm" data-action="export-data">データをエクスポート（JSON）</button>
        <div class="mt-8">
          <button class="btn btn-full btn-sm" style="border:1px solid var(--danger);color:var(--danger);background:var(--danger-light)" data-action="delete-all">全データを削除する</button>
        </div>
        <p class="text-muted mt-8" style="font-size:0.78rem;line-height:1.6">
          削除すると元に戻せません。記録が負担なら、削除より一時停止をおすすめします。
        </p>
      </div>

      <div class="card mt-12">
        <div style="font-size:0.8rem;color:var(--text-muted);line-height:1.7">
          本ツールは医療機器でも診断ツールでもありません。<br>
          気になる症状は医療機関にご相談ください。<br><br>
          体調の隠れ相関発見ノート v0.1
        </div>
      </div>
    </div>
    ${renderNav('settings')}
  `;
}

function renderNav(active) {
  const tabs = [
    { id:'record',      icon:'📝', label:'記録' },
    { id:'insights',    icon:'💡', label:'気づき' },
    { id:'experiments', icon:'🧪', label:'実験' },
    { id:'settings',    icon:'⚙️', label:'設定' },
  ];
  return `
    <nav class="bottom-nav">
      ${tabs.map(t=>`
        <button class="nav-btn ${active===t.id?'active':''}" data-action="nav" data-screen="${t.id}">
          <span class="nav-icon">${t.icon}</span><span>${t.label}</span>
        </button>
      `).join('')}
    </nav>
  `;
}

// ── データロード ──────────────────────────────────────────────────────────────

function loadRecord() {
  const today = todayStr();
  const metrics = db.getActiveMetrics();
  const existing = db.getTodayExisting();
  const settings = db.getSettings();
  const severeWarnings = metrics
    .filter(m => m.role==='symptom' && m.dtype==='binary' && checkSevereSymptoms(m.id))
    .map(m => m.name);
  state.todayData = {
    date:today, paused:!!settings.paused, metrics,
    existing_values:existing,
    severe_warning: severeWarnings.length ? SEVERE_SYMPTOM_MESSAGE : null,
  };
  state.metrics = metrics;
  state.formValues = {};
  for (const m of metrics) state.formValues[m.id] = existing[m.id] ?? null;
}

function loadInsights() { state.insights = db.getInsightsForUI(); }
function loadExperiments() { state.experiments = db.getExperimentsForUI(); }
function reloadSettings() { state.settings = db.getSettings(); }

// ── イベント処理 ──────────────────────────────────────────────────────────────

function attachListeners() {
  document.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click', handleAction));
  document.querySelectorAll('input[type=range]').forEach(el => el.addEventListener('input', handleSlider));
  document.querySelectorAll('#new-metric-name').forEach(el => el.addEventListener('input', e => { state.newMetric.name = e.target.value; }));
}

async function handleAction(e) {
  const el = e.currentTarget;
  const action = el.dataset.action;

  switch (action) {
    case 'nav':
      navigateTo(el.dataset.screen);
      break;

    case 'onboard-next':
      state.screen = 'onboarding-metrics';
      render();
      break;

    case 'onboard-complete':
      db.updateSettings({ onboarded:1 });
      state.settings.onboarded = 1;
      loadRecord();
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
      const name = (nameInput ? nameInput.value : state.newMetric.name).trim();
      if (!name) { alert('名前を入力してください'); return; }
      const m = db.addMetric(name, state.newMetric.role, state.newMetric.dtype);
      if (!m) { alert(`記録項目が${MAX_METRICS}件に達しています。`); return; }
      state.metrics.push(m);
      state.newMetric.name = '';
      render();
      break;
    }

    case 'add-metric-flow':
      state.metrics = db.getActiveMetrics();
      state.screen = 'onboarding-metrics';
      render();
      break;

    case 'archive-metric':
      if (!confirm('この項目を削除しますか？過去の記録は残ります。')) return;
      db.archiveMetric(el.dataset.id);
      state.metrics = state.metrics.filter(m => m.id != el.dataset.id);
      if (state.todayData) state.todayData.metrics = state.todayData.metrics.filter(m => m.id != el.dataset.id);
      reloadSettings();
      render();
      break;

    case 'set-binary':
      state.formValues[el.dataset.id] = Number(el.dataset.val);
      render();
      break;

    case 'save-record': {
      const entries = Object.entries(state.formValues)
        .filter(([,v]) => v !== null && v !== undefined)
        .map(([id, value]) => ({ metric_id:Number(id), value }));
      if (!entries.length) { alert('何か入力してください'); return; }
      db.saveEntries(todayStr(), entries);
      runFullScan();
      loadRecord();
      loadInsights();
      render();
      showToast('記録しました');
      break;
    }

    case 'dismiss-insight':
      db.dismissInsight(el.dataset.id);
      state.insights = state.insights.filter(i => i.id != el.dataset.id);
      render();
      break;

    case 'start-experiment': {
      const insightId = el.dataset.id;
      const rawIns = db._getAllInsights().find(i => i.id == insightId);
      if (!rawIns) return;
      const today = todayStr();
      const beforeVals = db.getEntries()
        .filter(e => e.metric_id==rawIns.symptom_id && e.date<today && e.value!==null)
        .sort((a,b) => b.date.localeCompare(a.date))
        .slice(0, 14)
        .map(e => e.value);
      const beforeRate = beforeVals.length ? beforeVals.reduce((a,b)=>a+b,0)/beforeVals.length : 0;
      const fName = getFactorName(rawIns.factor_ref);
      const intervention = buildExperimentProposal(fName, rawIns.effect > 0);
      db.addExperiment({ id:Date.now(), insight_id:rawIns.id, start_date:today, end_date:null, intervention, before_rate:beforeRate, after_rate:null, conclusion:null });
      showToast('実験を開始しました');
      state.insights = state.insights.map(i => i.id==insightId ? {...i,can_experiment:false} : i);
      loadExperiments();
      render();
      break;
    }

    case 'toggle-pause':
      db.updateSettings({ paused: state.settings.paused ? 0 : 1 });
      reloadSettings();
      loadRecord();
      render();
      break;

    case 'set-sensitivity':
      db.updateSettings({ sensitivity: el.dataset.val });
      reloadSettings();
      render();
      break;

    case 'export-data': {
      const data = {
        metrics:      db.getMetrics(),
        entries:      db.getEntries(),
        auto_factors: db._load(KEYS.autoFactors, []),
        experiments:  db.getExperimentsRaw(),
        settings:     db.getSettings(),
        exported_at:  new Date().toISOString(),
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href=url; a.download='health_export.json'; a.click();
      URL.revokeObjectURL(url);
      break;
    }

    case 'delete-all':
      if (!confirm('全データを削除します。この操作は元に戻せません。\n\n本当に削除しますか？')) return;
      if (!confirm('最終確認：全データを削除してよろしいですか？')) return;
      db.deleteAll();
      init();
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

function navigateTo(screen) {
  state.screen = screen;
  if (screen==='record')      loadRecord();
  if (screen==='insights')    loadInsights();
  if (screen==='experiments') loadExperiments();
  if (screen==='settings')    reloadSettings();
  render();
}

// ── トースト ──────────────────────────────────────────────────────────────────

function showToast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position:'fixed', bottom:'80px', left:'50%', transform:'translateX(-50%)',
    background:'rgba(0,0,0,0.75)', color:'#fff', padding:'10px 20px',
    borderRadius:'20px', fontSize:'0.9rem', zIndex:'9999', whiteSpace:'nowrap',
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

// ── 初期化 ────────────────────────────────────────────────────────────────────

function init() {
  state.settings = db.getSettings();
  db._ensureAutoFactor(todayStr());

  if (!state.settings.onboarded) {
    state.metrics = db.getActiveMetrics();
    state.screen = 'onboarding-safety';
  } else {
    loadRecord();
    runFullScan();
    loadInsights();
    loadExperiments();
    state.screen = 'record';
  }
  render();
}

init();
