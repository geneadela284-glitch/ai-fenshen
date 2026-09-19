import { useEffect, useMemo, useRef, useState, cloneElement, isValidElement } from 'react';
import { createHealthClient, healthIdempotencyKey, healthIsoToLocal, healthLocalDateTimeToIso } from '../../lib/healthClient.js';
import './health.css';
const pad = n => String(n).padStart(2, '0');
const localDay = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localMinute = () => `${localDay()}T${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
const plusDays = (day, n) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
};
const kindName = {
  metric: '指标',
  meal: '饮食',
  workout: '训练',
  reminder: '提醒',
  report: '报告',
  plan: '计划'
};
const metricName = {
  weight: '体重',
  bloodPressure: '血压',
  glucose: '血糖',
  temperature: '体温'
};
const mealName = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐'
};
const feelingName = {
  comfortable: '舒服',
  tired: '疲劳',
  pain: '疼痛',
  unrecorded: '未记录感受'
};
const goalName = {
  health: '保持健康',
  fitness: '提升体能',
  muscle: '增加力量',
  weight: '管理体重'
};
const emptyProfile = {
  subject: 'self',
  consentStorage: false,
  consentAI: false,
  goal: 'health',
  experience: 'beginner',
  daysPerWeek: 3,
  minutesPerSession: 20,
  equipment: [],
  allergies: [],
  dislikes: [],
  restrictions: '',
  servings: 1,
  cookingMinutes: 30,
  favorites: [],
  pantry: []
};
const jsonDownload = (data, name) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8'
  }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const csv = v => v.split(/[，,、\n]/).map(x => x.trim()).filter(Boolean);
const listText = v => (v || []).join('、');
const displayDate = value => value ? new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
  hour: value.includes?.('T') ? '2-digit' : undefined,
  minute: value.includes?.('T') ? '2-digit' : undefined
}).format(new Date(value.includes('T') ? value : `${value}T12:00:00`)) : '未填写';
function Modal({
  title,
  onClose,
  children,
  wide = false
}) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector('button,input,select,textarea')?.focus();
    const key = e => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const nodes = [...ref.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];
        if (!nodes.length) return;
        const first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus?.();
    };
  }, [onClose]);
  return <div className="health-modal-bg"><section ref={ref} className={`health-modal ${wide ? 'is-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="health-modal-title"><header><h2 id="health-modal-title">{title}</h2><button type="button" aria-label="关闭" onClick={onClose}>×</button></header>{children}</section></div>;
}
function Field({
  label,
  children,
  hint
}) {
  return <label className="health-field"><span>{label}</span>{isValidElement(children) && ['input', 'select', 'textarea'].includes(children.type) ? cloneElement(children, {
      'aria-label': label
    }) : children}{hint && <small>{hint}</small>}</label>;
}
function Empty({
  icon = '◇',
  title,
  children,
  action
}) {
  return <div className="health-empty"><i aria-hidden="true">{icon}</i><h3>{title}</h3><p>{children}</p>{action}</div>;
}
export default function HealthView({
  onBack,
  initialRecordId
}) {
  const client = useMemo(() => createHealthClient(), []),
    [tab, setTab] = useState('today'),
    [data, setData] = useState({
      enabled: true,
      profile: null,
      records: []
    }),
    [catalog, setCatalog] = useState({
      foods: [],
      recipes: [],
      exercises: []
    });
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [modal, setModal] = useState(null),
    [range, setRange] = useState(30),
    [custom, setCustom] = useState({
      from: plusDays(localDay(), -29),
      to: localDay()
    }),
    [summary, setSummary] = useState(null),
    [todaySummary, setTodaySummary] = useState(null),
    [shopping, setShopping] = useState(null);
  const initialOpened = useRef(false);
  async function refresh() {
    setError('');
    try {
      const [next, cat] = await Promise.all([client.load(), client.catalog()]);
      setData(next);
      setCatalog(cat);
      if (initialRecordId && !initialOpened.current) {
        const found = next.records.find(r => r.id === initialRecordId);
        if (found) {
          initialOpened.current = true;
          setTab(found.kind === 'plan' ? 'plan' : found.kind === 'report' ? 'profile' : found.kind === 'metric' ? 'trends' : 'today');
          if (found.kind !== 'plan') setModal({
            kind: found.kind === 'report' ? 'report' : 'record',
            record: found
          });
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    let live = true;
    client.summary({
      from: localDay(),
      to: localDay()
    }).then(s => {
      if (live) setTodaySummary(s);
    }).catch(() => {
      if (live) setTodaySummary(null);
    });
    return () => {
      live = false;
    };
  }, [data]);
  const records = data.records || [],
    profile = data.profile,
    plans = records.filter(r => r.kind === 'plan').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    activePlan = plans.find(r => ['draft', 'active'].includes(r.payload.status)),
    reports = records.filter(r => r.kind === 'report'),
    actual = records.filter(r => ['metric', 'meal', 'workout'].includes(r.kind)).sort((a, b) => (b.payload.measuredAt || b.createdAt).localeCompare(a.payload.measuredAt || a.createdAt)),
    reminders = records.filter(r => r.kind === 'reminder' && r.payload.status === 'pending');
  async function run(work, success) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setModal(null);
      await refresh();
      setNotice(success);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function remove(record) {
    if (!globalThis.confirm(`确认删除这条${kindName[record.kind] || '健康'}记录？删除后无法恢复。`)) return;
    run(() => client.removeRecord(record.id, record.revision), '记录已删除。');
  }
  function openActual(kind, record = null, defaults = {}) {
    if (!data.profile?.payload.consentStorage) {
      setTab('profile');
      setNotice('请先确认健康资料的保存范围，再记录。');
      return;
    }
    setModal({
      kind,
      record,
      defaults
    });
    setError('');
    setNotice('');
  }
  useEffect(() => {
    if (tab !== 'trends') return;
    const from = range === 'custom' ? custom.from : plusDays(localDay(), -(range - 1)),
      to = range === 'custom' ? custom.to : localDay();
    client.summary({
      from,
      to
    }).then(setSummary).catch(e => setError(e.message));
  }, [tab, range, custom.from, custom.to, data]);
  return <main className="health-shell" data-testid="feature-health">
  <header className="health-top"><button type="button" className="health-back" aria-label="返回主界面" onClick={onBack}>‹ <span>返回主界面</span></button><div><p>AI 分身 · 私人空间</p><h1>健康</h1></div><span className="health-lock">独立健康空间</span></header>
  <nav className="health-tabs" aria-label="健康页面"><button type="button" aria-current={tab === 'today' ? 'page' : undefined} onClick={() => setTab('today')}>今日</button><button type="button" aria-current={tab === 'plan' ? 'page' : undefined} onClick={() => setTab('plan')}>计划</button><button type="button" aria-current={tab === 'trends' ? 'page' : undefined} onClick={() => setTab('trends')}>趋势</button><button type="button" aria-current={tab === 'profile' ? 'page' : undefined} onClick={() => setTab('profile')}>档案</button></nav>
  {notice && <p className="health-notice" role="status">{notice}</p>}{error && <p className="health-error" role="alert">{error}</p>}
  {loading ? <Empty icon="◌" title="正在读取健康资料">只会显示你亲自保存或确认过的内容。</Empty> : tab === 'today' ? <Today summary={todaySummary} records={actual} plan={plans.find(r => r.payload.status === 'active')} catalog={catalog} reminders={reminders} open={openActual} setModal={setModal} remove={remove} client={client} run={run} busy={busy} /> : tab === 'plan' ? <Plan profile={profile} plan={activePlan} catalog={catalog} client={client} run={run} busy={busy} shopping={shopping} setShopping={setShopping} open={openActual} /> : tab === 'trends' ? <Trends records={actual.filter(r => r.kind === 'metric')} range={range} setRange={setRange} custom={custom} setCustom={setCustom} summary={summary} edit={r => openActual('metric', r)} remove={remove} /> : <Profile profile={profile} reports={reports} catalog={catalog} client={client} run={run} busy={busy} setModal={setModal} />}
  {modal?.kind === 'metric' && <MetricForm state={modal} close={() => setModal(null)} run={run} client={client} busy={busy} />}
  {modal?.kind === 'meal' && <MealForm state={modal} close={() => setModal(null)} run={run} client={client} catalog={catalog} busy={busy} />}
  {modal?.kind === 'workout' && <WorkoutForm state={modal} close={() => setModal(null)} run={run} client={client} busy={busy} />}
  {modal?.kind === 'reminder' && <ReminderForm state={modal} close={() => setModal(null)} run={run} client={client} busy={busy} />}
  {modal?.kind === 'report' && <ReportReview record={modal.record} client={client} close={() => setModal(null)} run={run} busy={busy} />}
  {modal?.kind === 'record' && <Modal title={`${kindName[modal.record.kind] || '健康'}记录`} onClose={() => setModal(null)}><RecordDetails record={modal.record} /><div className="health-actions"><button type="button" onClick={() => remove(modal.record)}>删除</button><button type="button" className="primary" onClick={() => openActual(modal.record.kind, modal.record)}>更正记录</button></div></Modal>}
 </main>;
}
function Today({
  summary,
  plan,
  catalog,
  records,
  reminders,
  open,
  setModal,
  remove,
  client,
  run,
  busy
}) {
  return <div className="health-page"><section className="health-hero"><div><p>今天 · {displayDate(localDay())}</p><h2>照顾自己，从真实记录开始</h2><span>这里不判断“正常”或“异常”，只帮你留住变化。</span></div><div className="health-score"><strong>{records.filter(r => r.occurredOn === localDay()).length}</strong><small>今日记录</small></div></section><TodayAgenda plan={plan} catalog={catalog} />{summary && <section className="health-daily-food"><h2>今天的饮食记录</h2><p>已记录 {summary.mealCount} 餐{summary.accountedMeals > 0 ? `，其中 ${summary.accountedMeals} 餐已核对食材，合计约 ${summary.approxKcal} 千卡。` : '，尚无完整份量，不估算热量。'}</p><small>只统计你记录并核对的食材，不代表全天实际摄入；额外用油和调料需计入。</small></section>}<section><header className="health-section-head"><div><small>QUICK RECORD</small><h2>快速记录</h2></div></header><div className="health-quick"><button type="button" onClick={() => open('metric', null, {
          type: 'weight'
        })}>⚖<span>体重</span></button><button type="button" onClick={() => open('metric', null, {
          type: 'bloodPressure'
        })}>♡<span>血压</span></button><button type="button" onClick={() => open('metric', null, {
          type: 'glucose'
        })}>◒<span>血糖</span></button><button type="button" onClick={() => open('metric', null, {
          type: 'temperature'
        })}>♨<span>体温</span></button><button type="button" onClick={() => open('meal')}>⌁<span>饮食</span></button><button type="button" onClick={() => open('workout')}>↗<span>训练</span></button><button type="button" onClick={() => open('reminder')}>○<span>提醒</span></button></div></section><section><header className="health-section-head"><div><small>RECENT</small><h2>最近记录</h2></div></header>{records.length ? <div className="health-list">{records.slice(0, 8).map(r => <article key={r.id}><button type="button" className="health-list-main" onClick={() => setModal({
            kind: 'record',
            record: r
          })}><span className={`health-dot ${r.kind}`} /><span><strong>{recordTitle(r)}</strong><small>{displayDate(r.payload.measuredAt || r.occurredOn)} · {kindName[r.kind]}</small></span></button><button type="button" onClick={() => open(r.kind, r)} aria-label={`更正${recordTitle(r)}`}>更正</button><button type="button" onClick={() => remove(r)} aria-label={`删除${recordTitle(r)}`}>删除</button></article>)}</div> : <Empty title="还没有健康记录">你保存第一条记录后，它会出现在这里。未记录不会被补成 0。</Empty>}</section><section><header className="health-section-head"><div><small>REMINDERS</small><h2>健康提醒</h2></div></header>{reminders.length ? <div className="health-list">{reminders.map(r => <article key={r.id}><div className="health-list-main"><span className="health-dot reminder" /><span><strong>{r.payload.title}</strong><small>{displayDate(r.payload.scheduledAt)}</small></span></div><button type="button" disabled={busy} onClick={() => run(() => client.reminderAction(r.id, {
            revision: r.revision,
            action: 'complete'
          }), '提醒已完成。')}>完成</button><button type="button" onClick={() => open('reminder', r)}>延期</button><button type="button" disabled={busy} onClick={() => run(() => client.reminderAction(r.id, {
            revision: r.revision,
            action: 'cancel'
          }), '提醒已取消。')}>取消</button></article>)}</div> : <Empty title="没有待处理提醒">需要时可以添加一次或每周提醒。</Empty>}</section></div>;
}
function TodayAgenda({
  plan,
  catalog
}) {
  const day = plan?.payload.status === 'active' && plan.payload.days.find(d => d.date === localDay());
  if (!day) return null;
  return <section className="health-today-plan"><header className="health-section-head"><div><small>TODAY’S PLAN</small><h2>今天的安排</h2></div><span>实际完成后再记录</span></header><div className="health-summary">{day.meals.map(m => <article key={m.slot}><small>{mealName[m.slot]}</small><span>{catalog.recipes.find(r => r.id === m.recipeId)?.name}</span></article>)}<article><small>运动</small><span>{day.workout ? day.workout.minutes + ' 分钟基础活动' : '休息与日常活动'}</span></article></div></section>;
}
function recordTitle(r) {
  if (r.kind === 'metric') {
    const p = r.payload;
    return `${metricName[p.type]} ${p.value}${p.type === 'bloodPressure' ? `/${p.secondaryValue}` : ''} ${{
      jin: '斤',
      kg: '公斤'
    }[p.unit] || p.unit}`;
  }
  if (r.kind === 'meal') return `${mealName[r.payload.meal]} · ${r.payload.name}`;
  if (r.kind === 'workout') return `${r.payload.name} · ${r.payload.minutes} 分钟`;
  return r.payload.title || kindName[r.kind];
}
function RecordDetails({
  record: r
}) {
  const p = r.payload;
  return <div className="health-detail"><p><b>记录</b>{recordTitle(r)}</p><p><b>日期</b>{r.occurredOn}</p>{p.measuredAt && <p><b>测量时间</b>{displayDate(p.measuredAt)}</p>}{p.status && <p><b>状态</b>{{
        confirmed: '已确认',
        draft: '待补充',
        pending: '待处理',
        completed: '已完成',
        cancelled: '已取消'
      }[p.status] || '已保存'}</p>}{p.feeling && <p><b>感受</b>{feelingName[p.feeling]}</p>}{p.note && <p><b>备注</b>{p.note}</p>}{p.source?.text && <p><b>原话</b>{p.source.text}</p>}</div>;
}
function MetricForm({
  state,
  close,
  run,
  client,
  busy
}) {
  const old = state.record?.payload,
    [form, setForm] = useState({
      type: old?.type || state.defaults?.type || 'weight',
      value: old?.value || '',
      secondaryValue: old?.secondaryValue || '',
      unit: old?.unit ?? {
        weight: 'kg',
        bloodPressure: 'mmHg',
        glucose: 'mmol/L',
        temperature: '°C'
      }[state.defaults?.type || 'weight'],
      measuredAt: healthIsoToLocal(old?.measuredAt) || localMinute(),
      context: old?.context || '',
      status: old?.status || 'confirmed',
      note: old?.note || ''
    });
  const submissionKey = useMemo(() => healthIdempotencyKey(), [JSON.stringify(form)]);
  const submit = e => {
    e.preventDefault();
    const payload = {
      ...form,
      value: Number(form.value),
      ...(form.type === 'bloodPressure' ? {
        secondaryValue: Number(form.secondaryValue)
      } : {}),
      measuredAt: healthLocalDateTimeToIso(form.measuredAt),
      context: form.type === 'glucose' ? form.context : form.context || 'selfReported',
      status: form.type === 'glucose' && !form.context ? 'draft' : form.status
    };
    if (form.type !== 'bloodPressure') delete payload.secondaryValue;
    run(() => state.record ? client.updateRecord(state.record.id, {
      revision: state.record.revision,
      payload,
      occurredOn: form.measuredAt.slice(0, 10)
    }) : client.createRecord({
      kind: 'metric',
      occurredOn: form.measuredAt.slice(0, 10),
      payload,
      idempotencyKey: submissionKey
    }), state.record ? '指标已更正。' : payload.status === 'draft' ? '指标已保存为草稿，请补充血糖情境后确认。' : '指标已保存。');
  };
  return <Modal title={state.record ? '更正身体指标' : '记录身体指标'} onClose={close}><form onSubmit={submit} className="health-form"><Field label="指标"><select value={form.type} onChange={e => setForm({
          ...form,
          type: e.target.value,
          unit: {
            weight: 'kg',
            bloodPressure: 'mmHg',
            glucose: 'mmol/L',
            temperature: '°C'
          }[e.target.value],
          context: '',
          secondaryValue: ''
        })}><option value="weight">体重</option><option value="bloodPressure">血压</option><option value="glucose">血糖</option><option value="temperature">体温</option></select></Field><div className="health-form-row"><Field label={form.type === 'bloodPressure' ? '收缩压' : '数值'}><input required type="number" step="any" min="0.01" value={form.value} onChange={e => setForm({
            ...form,
            value: e.target.value
          })} /></Field>{form.type === 'bloodPressure' && <Field label="舒张压"><input required type="number" min="1" max="400" value={form.secondaryValue} onChange={e => setForm({
            ...form,
            secondaryValue: e.target.value
          })} /></Field>}<Field label="单位"><select value={form.unit} onChange={e => setForm({
            ...form,
            unit: e.target.value
          })}>{form.type === 'weight' ? <><option>kg</option><option>jin</option></> : form.type === 'glucose' ? <><option>mmol/L</option><option>mg/dL</option></> : form.type === 'temperature' ? <><option>°C</option><option>°F</option></> : <option>mmHg</option>}</select></Field></div>{form.type === 'glucose' && <Field label="测量情境" hint="未选择情境时会保存为待确认草稿。"><select value={form.context} onChange={e => setForm({
          ...form,
          context: e.target.value
        })}><option value="">暂不确定</option><option value="fasting">空腹</option><option value="afterMeal">餐后</option><option value="random">随机</option></select></Field>}<Field label="测量日期与时间"><input required type="datetime-local" value={form.measuredAt} onChange={e => setForm({
          ...form,
          measuredAt: e.target.value
        })} /></Field><Field label="备注（选填）"><textarea value={form.note} onChange={e => setForm({
          ...form,
          note: e.target.value
        })} /></Field><p className="health-help">数值范围只用于发现录入错误，不提供健康诊断。</p><div className="health-actions"><button type="button" onClick={close}>取消</button><button type="submit" className="primary" disabled={busy}>{busy ? '保存中…' : '保存指标'}</button></div></form></Modal>;
}
function MealForm({
  state,
  close,
  run,
  client,
  catalog,
  busy
}) {
  const p = state.record?.payload,
    [form, setForm] = useState({
      name: p?.name || catalog.recipes.find(r => r.id === state.defaults?.recipeId)?.name || '',
      occurredOn: state.record?.occurredOn || localDay(),
      items: p?.items?.map(i => ({
        ...i,
        grams: i.grams / (p.servings || 1)
      })),
      amountsConfirmed: !!p?.items?.length,
      meal: p?.meal || state.defaults?.meal || 'breakfast',
      recipeId: p?.recipeId || state.defaults?.recipeId || '',
      servings: p?.servings || 1,
      note: p?.note || ''
    });
  const submissionKey = useMemo(() => healthIdempotencyKey(), [JSON.stringify(form)]);
  return <Modal title={state.record ? '更正饮食记录' : '记录实际饮食'} onClose={close}><form className="health-form" onSubmit={e => {
      e.preventDefault();
      const selectedRecipe = catalog.recipes.find(r => r.id === form.recipeId);
      const payload = {
        ...form,
        items: form.amountsConfirmed ? (form.items || selectedRecipe?.ingredients || []).map(i => ({
          ...i,
          grams: i.grams * form.servings
        })) : undefined,
        ...(!form.recipeId ? {
          recipeId: undefined
        } : {})
      };
      delete payload.amountsConfirmed;
      run(() => state.record ? client.updateRecord(state.record.id, {
        revision: state.record.revision,
        occurredOn: form.occurredOn,
        payload
      }) : client.createRecord({
        kind: 'meal',
        occurredOn: form.occurredOn,
        payload,
        idempotencyKey: submissionKey
      }), state.record ? '饮食记录已更正。' : '实际饮食已记录。');
    }}><Field label="实际日期"><input type="date" required max={localDay()} value={form.occurredOn} onChange={e => setForm({
          ...form,
          occurredOn: e.target.value
        })} /></Field><Field label="餐次"><select value={form.meal} onChange={e => setForm({
          ...form,
          meal: e.target.value
        })}>{Object.entries(mealName).map(([v, n]) => <option value={v} key={v}>{n}</option>)}</select></Field><Field label="吃了什么"><input required maxLength="100" value={form.name} onChange={e => setForm({
          ...form,
          name: e.target.value
        })} placeholder="例如：番茄鸡蛋和米饭" /></Field><Field label="来自菜谱（选填）"><select value={form.recipeId} onChange={e => setForm({
          ...form,
          recipeId: e.target.value,
          items: undefined,
          amountsConfirmed: false,
          name: e.target.value ? catalog.recipes.find(r => r.id === e.target.value)?.name || form.name : form.name
        })}><option value="">没有使用菜谱</option>{catalog.recipes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field><Field label="实际吃了几份"><input type="number" min="1" max="8" value={form.servings} onChange={e => setForm({
          ...form,
          servings: Number(e.target.value)
        })} /></Field>{form.recipeId && <fieldset><legend>核对食材份量（选填）</legend><label className="health-switch"><input type="checkbox" checked={form.amountsConfirmed || false} onChange={e => setForm({
            ...form,
            amountsConfirmed: e.target.checked
          })} /><span>我愿意核对每份食材生重，用于营养估算</span></label>{form.amountsConfirmed && (form.items || catalog.recipes.find(r => r.id === form.recipeId)?.ingredients || []).map((item, index) => <Field key={item.foodId} label={(catalog.foods.find(f => f.id === item.foodId)?.name || item.foodId) + ' 每份克数'}><input type="number" min="0.1" step="0.1" required value={item.grams} onChange={e => {
            const next = (form.items || catalog.recipes.find(r => r.id === form.recipeId).ingredients).map(i => ({
              ...i
            }));
            next[index].grams = Number(e.target.value);
            setForm({
              ...form,
              items: next
            });
          }} /></Field>)}</fieldset>}<Field label="补充说明"><textarea value={form.note} onChange={e => setForm({
          ...form,
          note: e.target.value
        })} /></Field><p className="health-help">没有完整食材生重时，只保存文字记录，不显示精确营养。</p><div className="health-actions"><button type="button" onClick={close}>取消</button><button type="submit" className="primary" disabled={busy}>保存饮食</button></div></form></Modal>;
}
function WorkoutForm({
  state,
  close,
  run,
  client,
  busy
}) {
  const p = state.record?.payload,
    [form, setForm] = useState({
      name: p?.name || state.defaults?.name || '',
      occurredOn: state.record?.occurredOn || localDay(),
      minutes: p?.minutes || '',
      feeling: p?.feeling || '',
      note: p?.note || ''
    });
  const submissionKey = useMemo(() => healthIdempotencyKey(), [JSON.stringify(form)]);
  return <Modal title={state.record ? '更正训练记录' : '记录实际训练'} onClose={close}><form className="health-form" onSubmit={e => {
      e.preventDefault();
      run(() => state.record ? client.updateRecord(state.record.id, {
        revision: state.record.revision,
        occurredOn: form.occurredOn,
        payload: {
          ...form,
          minutes: Number(form.minutes)
        }
      }) : client.createRecord({
        kind: 'workout',
        occurredOn: form.occurredOn,
        payload: {
          ...form,
          minutes: Number(form.minutes)
        },
        idempotencyKey: submissionKey
      }), state.record ? '训练记录已更正。' : '实际训练已记录。');
    }}><Field label="实际日期"><input type="date" required max={localDay()} value={form.occurredOn} onChange={e => setForm({
          ...form,
          occurredOn: e.target.value
        })} /></Field><Field label="做了什么"><input required value={form.name} onChange={e => setForm({
          ...form,
          name: e.target.value
        })} placeholder="例如：舒适步行" /></Field><Field label="持续时间（分钟）"><input required type="number" min="1" max="300" value={form.minutes} onChange={e => setForm({
          ...form,
          minutes: e.target.value
        })} /></Field><fieldset><legend>本次感受（请主动选择）</legend><div className="health-choice">{Object.entries(feelingName).map(([v, n]) => <label key={v}><input required type="radio" name="feeling" value={v} checked={form.feeling === v} onChange={e => setForm({
              ...form,
              feeling: e.target.value
            })} /><span>{n}</span></label>)}</div></fieldset><Field label="备注"><textarea value={form.note} onChange={e => setForm({
          ...form,
          note: e.target.value
        })} /></Field><div className="health-actions"><button type="button" onClick={close}>取消</button><button type="submit" className="primary" disabled={busy || !form.feeling}>保存训练</button></div></form></Modal>;
}
function ReminderForm({
  state,
  close,
  run,
  client,
  busy
}) {
  const p = state.record?.payload,
    [form, setForm] = useState({
      title: p?.title || '',
      scheduledAt: healthIsoToLocal(p?.scheduledAt) || localMinute(),
      repeat: p?.repeat || 'none'
    });
  const submissionKey = useMemo(() => healthIdempotencyKey(), [JSON.stringify(form)]);
  return <Modal title={state.record ? '调整提醒' : '添加健康提醒'} onClose={close}><form className="health-form" onSubmit={e => {
      e.preventDefault();
      if (state.record) {
        run(() => client.reminderAction(state.record.id, {
          revision: state.record.revision,
          action: 'snooze',
          scheduledAt: healthLocalDateTimeToIso(form.scheduledAt)
        }), '提醒已延期。');
      } else run(() => client.createRecord({
        kind: 'reminder',
        occurredOn: form.scheduledAt.slice(0, 10),
        payload: {
          title: form.title,
          scheduledAt: healthLocalDateTimeToIso(form.scheduledAt),
          timezone: 'Asia/Shanghai',
          repeat: form.repeat,
          status: 'pending'
        },
        idempotencyKey: submissionKey
      }), '提醒已添加。');
    }}>{!state.record && <Field label="提醒内容"><input required value={form.title} onChange={e => setForm({
          ...form,
          title: e.target.value
        })} /></Field>}<Field label="日期与时间"><input required type="datetime-local" value={form.scheduledAt} onChange={e => setForm({
          ...form,
          scheduledAt: e.target.value
        })} /></Field>{!state.record && <Field label="重复"><select value={form.repeat} onChange={e => setForm({
          ...form,
          repeat: e.target.value
        })}><option value="none">仅一次</option><option value="weekly">每周</option></select></Field>}<div className="health-actions"><button type="button" onClick={close}>取消</button><button type="submit" className="primary" disabled={busy}>确认</button></div></form></Modal>;
}
function Trends({
  records,
  range,
  setRange,
  custom,
  setCustom,
  summary,
  edit,
  remove
}) {
  const from = range === 'custom' ? custom.from : plusDays(localDay(), -(range - 1)),
    to = range === 'custom' ? custom.to : localDay(),
    within = records.filter(r => r.occurredOn >= from && r.occurredOn <= to),
    types = ['weight', 'bloodPressure', 'glucose', 'temperature'];
  return <div className="health-page"><section className="health-hero compact"><div><p>真实记录 · 不补零</p><h2>看见身体的变化</h2><span>只有同类、同单位且已确认的点会连接。</span></div></section><div className="health-range">{[7, 30, 90].map(n => <button type="button" key={n} aria-pressed={range === n} onClick={() => setRange(n)}>{n} 天</button>)}<button type="button" aria-pressed={range === 'custom'} onClick={() => setRange('custom')}>自定义</button></div>{range === 'custom' && <div className="health-form-row"><Field label="开始"><input type="date" value={custom.from} onChange={e => setCustom({
          ...custom,
          from: e.target.value
        })} /></Field><Field label="结束"><input type="date" value={custom.to} onChange={e => setCustom({
          ...custom,
          to: e.target.value
        })} /></Field></div>}<section className="health-summary">{summary ? <><article><strong>{summary.recordedDays}</strong><span>有记录天数</span></article><article><strong>{summary.metricCount}</strong><span>确认指标</span></article><article><strong>{summary.mealCount}</strong><span>饮食记录</span></article><article><strong>{summary.workoutMinutes}</strong><span>训练分钟</span></article></> : <p>正在统计实际记录…</p>}</section>{types.map(type => <TrendCard key={type} type={type} records={within.filter(r => r.payload.type === type)} edit={edit} remove={remove} />)}</div>;
}
function TrendCard({
  type,
  records,
  edit,
  remove
}) {
  const groups = Object.values(records.filter(r => r.payload.status === 'confirmed').reduce((map, r) => {
    const k = r.payload.unit + ':' + (type === 'glucose' ? r.payload.context : '');
    (map[k] ??= []).push(r);
    return map;
  }, {}));
  return <section className="health-trend"><header className="health-section-head"><div><small>METRIC</small><h2>{metricName[type]}</h2></div><span>{records.length} 条</span></header>{!records.length ? <p className="health-help">此时间范围没有记录。</p> : <>{groups.map((items, i) => {
        items.sort((a, b) => a.payload.measuredAt.localeCompare(b.payload.measuredAt));
        const values = items.map(r => Number(r.payload.value)),
          min = Math.min(...values, ...(type === 'bloodPressure' ? items.map(r => Number(r.payload.secondaryValue)) : [])),
          max = Math.max(...values),
          span = max - min || 1;
        const times = items.map(r => Date.parse(r.payload.measuredAt)),
          minTime = Math.min(...times),
          timeSpan = Math.max(...times) - minTime;
        const pointX = index => timeSpan ? (times[index] - minTime) / timeSpan * 100 : 50;
        const pointY = index => 100 - (values[index] - min) / span * 70 - 15;
        return <div key={i} className="health-chart" aria-label={`${metricName[type]} ${items[0].payload.unit}趋势`}><div className="health-chart-line">{items.length > 1 && <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points={items.map((_, i) => pointX(i) + ',' + pointY(i)).join(' ')} fill="none" stroke="#8cab80" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />{type === 'bloodPressure' && <polyline points={items.map((r, i) => pointX(i) + ',' + (100 - (Number(r.payload.secondaryValue) - min) / span * 70 - 15)).join(' ')} fill="none" stroke="#b48857" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}</svg>}{items.map((r, index) => <button type="button" key={r.id} style={{
              '--x': `${pointX(index)}%`,
              '--y': `${100 - (Number(r.payload.value) - min) / span * 70 - 15}%`
            }} title={`${r.occurredOn} ${r.payload.value}${r.payload.unit}`} onClick={() => edit(r)}><span /></button>)}{type === 'bloodPressure' && items.map((r, index) => <button type="button" key={'low-' + r.id} aria-label={'舒张压 ' + r.payload.secondaryValue} style={{
              '--x': `${pointX(index)}%`,
              '--y': `${100 - (Number(r.payload.secondaryValue) - min) / span * 70 - 15}%`,
              color: '#b48857'
            }} onClick={() => edit(r)}><span /></button>)}</div>{type === 'bloodPressure' && <small>绿色：收缩压 · 棕色：舒张压</small>}<small>{{
              jin: '斤',
              kg: '公斤'
            }[items[0].payload.unit] || items[0].payload.unit} {type === 'glucose' ? {
              fasting: '空腹',
              afterMeal: '餐后',
              random: '随机'
            }[items[0].payload.context] : ''} · {items.length === 1 ? '仅一条，不连线' : `${items[0].payload.value} → ${items.at(-1).payload.value}`}</small></div>;
      })}<div className="health-list">{records.map(r => <article key={r.id}><button className="health-list-main" type="button" onClick={() => edit(r)}><span><strong>{recordTitle(r)}</strong><small>{r.occurredOn}{r.payload.status === 'draft' ? ' · 待确认草稿' : ''}</small></span></button><button type="button" onClick={() => edit(r)}>更正</button><button type="button" onClick={() => remove(r)}>删除</button></article>)}</div></>}</section>;
}
function Plan({
  profile,
  plan,
  catalog,
  client,
  run,
  busy,
  shopping,
  setShopping,
  open
}) {
  const [request, setRequest] = useState('一周安排简单、容易坚持'),
    [startDate, setStartDate] = useState(localDay()),
    [allowed, setAllowed] = useState([]),
    [constraintError, setConstraintError] = useState(''),
    [change, setChange] = useState(null),
    [recipeOpen, setRecipeOpen] = useState(null),
    [servings, setServings] = useState(1),
    [favoritesOnly, setFavoritesOnly] = useState(false);
  useEffect(() => {
    let live = true;
    client.recipes(1).then(r => {
      if (live) {
        setAllowed(r);
        setConstraintError('');
      }
    }).catch(e => {
      if (live) setConstraintError(e.message);
    });
    return () => {
      live = false;
    };
  }, [profile?.revision]);
  const recipeMap = Object.fromEntries(catalog.recipes.map(r => [r.id, r])),
    exerciseMap = Object.fromEntries(catalog.exercises.map(e => [e.id, e]));
  const generate = mode => run(() => client.draftPlan({
    request,
    startDate,
    mode,
    idempotencyKey: healthIdempotencyKey()
  }), mode === 'ai' ? 'AI草案已生成，请核对后启用。' : '基础规则草案已生成，请核对后启用。');
  const favorite = id => run(() => client.saveProfile({
    revision: profile.revision,
    payload: {
      ...profile.payload,
      favorites: (profile.payload.favorites || []).includes(id) ? profile.payload.favorites.filter(x => x !== id) : [...(profile.payload.favorites || []), id]
    }
  }), '收藏已更新。');
  const owned = (id, checked) => run(() => client.saveProfile({
    revision: profile.revision,
    payload: {
      ...profile.payload,
      pantry: checked ? [...new Set([...(profile.payload.pantry || []), id])] : (profile.payload.pantry || []).filter(x => x !== id)
    }
  }), '家中食材已更新。');
  const safeRecipes = allowed.filter(r => !favoritesOnly || profile?.payload.favorites?.includes(r.id));
  return <div className="health-page">
  <section className="health-hero compact"><div><p>每周安排 · 每日照顾</p><h2>好好吃饭，慢慢变强</h2><span>运动、三餐和采购清单放在一起。计划先核对，实际完成再记录。</span></div></section>
  {!profile?.payload.consentStorage ? <Empty title="从了解自己开始">先在档案选择保存范围与生活偏好，再安排适合自己的一周。</Empty> : <>
   <details className="health-plan-start" open={!plan}><summary>制定一份新周计划</summary><Field label="开始日期"><input type="date" required min={localDay()} value={startDate} onChange={e => setStartDate(e.target.value)} /></Field><Field label="希望怎样安排"><textarea value={request} onChange={e => setRequest(e.target.value)} placeholder="例如：每周三天，每次15分钟，晚餐简单一些" /></Field><p className="health-help">计划遵循档案中的过敏、器材和时间限制；新增的健康限制请先补充到档案。</p><div className="health-actions"><button className="primary" type="button" disabled={busy || !profile.payload.consentAI} onClick={() => generate('ai')}>{busy ? '正在处理…' : '生成AI周计划'}</button><button type="button" disabled={busy} onClick={() => generate('rules')}>生成基础规则草案</button></div>{!profile.payload.consentAI && <p className="health-help">尚未授权AI分析，仍可使用基础规则安排。</p>}</details>
   {plan && <>
    <section className="health-plan-head"><div><small>{plan.payload.mode === 'ai' ? 'AI建议' : '基础规则安排'} · {plan.payload.status === 'active' ? '已启用' : '待你确认'}</small><h2>{plan.payload.startDate} 起的一周</h2></div>{plan.payload.status === 'draft' && <button type="button" className="primary" disabled={busy} onClick={() => run(() => client.confirmPlan(plan.id, plan.revision), '这份计划已启用。')}>确认启用</button>}</section>
    <details className="health-basis"><summary>安排依据{plan.payload.changes?.length ? '与本次调整' : ''}</summary>{[...(plan.payload.changes || []), ...plan.payload.basis].map((x, i) => <p key={i}>{x}</p>)}</details>
    <div className="health-week">{plan.payload.days.map(day => <article key={day.date}><header><time>{displayDate(day.date)}</time><span>{day.date === localDay() ? '今天' : day.date < localDay() ? '历史安排' : '待进行'}</span></header>
     {day.meals.map(meal => <details key={meal.slot}><summary>{mealName[meal.slot]} · {recipeMap[meal.recipeId]?.name || '菜谱'}</summary>{recipeMap[meal.recipeId] && <Recipe recipe={recipeMap[meal.recipeId]} servings={meal.servings} foods={catalog.foods} />}<div className="health-plan-change"><button type="button" disabled={busy} onClick={() => favorite(meal.recipeId)}>{profile.payload.favorites?.includes(meal.recipeId) ? '已收藏' : '收藏菜谱'}</button><button type="button" disabled={day.date < localDay() || busy} onClick={() => setChange({
                  date: day.date,
                  slot: meal.slot,
                  recipeId: meal.recipeId,
                  servings: meal.servings
                })}>换菜 / 调整人数</button><button type="button" onClick={() => open('meal', null, {
                  recipeId: meal.recipeId,
                  meal: meal.slot
                })}>记实际吃过</button></div></details>)}
     {day.workout ? <details><summary>运动 · {day.workout.minutes} 分钟</summary>{day.workout.exerciseIds.map(id => <div className="health-exercise" key={id}><b>{exerciseMap[id]?.name}</b><span>{exerciseMap[id]?.reps} · 组间休息 {exerciseMap[id]?.restSeconds} 秒</span><ol>{exerciseMap[id]?.instructions.map(x => <li key={x}>{x}</li>)}</ol><a href={exerciseMap[id]?.source} target="_blank" rel="noreferrer">查看原始动作示范</a></div>)}<p className="health-help">有疼痛或不适时停止，先核对适用活动。</p><div className="health-plan-change"><button type="button" disabled={day.date < localDay()} onClick={() => setChange({
                  date: day.date,
                  slot: 'workout',
                  exerciseIds: day.workout.exerciseIds,
                  minutes: day.workout.minutes
                })}>换动作 / 调整时间</button><button type="button" onClick={() => open('workout', null, {
                  name: '计划训练'
                })}>记实际完成</button></div></details> : <p className="health-help">今天留给休息和日常活动。</p>}
    </article>)}</div><button type="button" disabled={busy} onClick={() => run(async () => {
          setShopping(await client.shopping(plan.id));
        }, '采购清单已汇总。')}>查看这一周采购清单</button>
    {shopping && <section className="health-shopping"><h3>采购清单</h3><p className="health-help">已合并相同食材，按整份计划计算。勾选家中已有的食材。</p>{shopping.map(i => <StockItem key={i.foodId} item={i} saved={profile.payload.pantry?.includes(i.foodId) || false} save={checked => owned(i.foodId, checked)} busy={busy} />)}</section>}
   </>}
   <section><header className="health-section-head"><div><small>EVERYDAY RECIPES</small><h2>家常菜谱</h2></div><button type="button" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}>{favoritesOnly ? '看全部' : '我的收藏'}</button></header><p className="health-help">根据已填写的过敏与忌口筛选；成品配料和交叉接触还需本人核对。仅作一般饮食安排。</p>{constraintError ? <p role="alert" className="health-caution">{constraintError}</p> : <div className="health-recipe-grid">{safeRecipes.map(r => <article className="health-recipe-card" key={r.id}><div className="health-recipe-visual" aria-hidden="true">{r.meal === 'breakfast' ? '晨食' : '家味'}</div><h3>{r.name}</h3><small>{r.minutes} 分钟 · {r.budget}</small><div className="health-actions"><button type="button" onClick={() => {
                setRecipeOpen(r);
                setServings(1);
              }}>看做法</button><button type="button" disabled={busy} onClick={() => favorite(r.id)}>{profile.payload.favorites?.includes(r.id) ? '已收藏' : '收藏'}</button></div></article>)}</div>}</section>
  </>}
  {recipeOpen && <Modal title={recipeOpen.name} onClose={() => setRecipeOpen(null)}><Field label="查看人数"><input type="number" min="1" max="8" step="1" value={servings} onChange={e => setServings(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} /></Field><Recipe recipe={recipeOpen} servings={servings} foods={catalog.foods} /><div className="health-actions"><button type="button" onClick={() => {
          open('meal', null, {
            recipeId: recipeOpen.id
          });
          setRecipeOpen(null);
        }}>记实际吃过</button>{plan && <button type="button" className="primary" onClick={() => {
          setChange({
            date: plan.payload.days.find(d => d.date >= localDay())?.date || localDay(),
            slot: recipeOpen.meal === 'breakfast' ? 'breakfast' : 'dinner',
            recipeId: recipeOpen.id,
            servings
          });
          setRecipeOpen(null);
        }}>加入某天计划</button>}</div></Modal>}
  {change && plan && <Modal title="调整未来安排" onClose={() => setChange(null)}><form className="health-form" onSubmit={e => {
        e.preventDefault();
        run(() => client.changePlan(plan.id, {
          ...change,
          revision: plan.revision,
          idempotencyKey: healthIdempotencyKey()
        }), '调整已生成新草案，请核对后确认。').then(ok => {
          if (ok) setChange(null);
        });
      }}><Field label="日期"><select value={change.date} onChange={e => setChange({
            ...change,
            date: e.target.value
          })}>{plan.payload.days.filter(d => d.date >= localDay()).map(d => <option key={d.date}>{d.date}</option>)}</select></Field>{change.slot === 'workout' ? <><Field label="时间上限内的实际安排（分钟）"><input type="number" min="5" max={profile.payload.minutesPerSession} required value={change.minutes} onChange={e => setChange({
              ...change,
              minutes: Number(e.target.value)
            })} /></Field><div className="health-choice">{catalog.exercises.filter(ex => ex.equipment.every(e => profile.payload.equipment.includes(e))).map(ex => <label key={ex.id}><input type="checkbox" checked={change.exerciseIds.includes(ex.id)} onChange={e => setChange({
                ...change,
                exerciseIds: e.target.checked ? [...change.exerciseIds, ex.id] : change.exerciseIds.filter(x => x !== ex.id)
              })} /><span>{ex.name} · {ex.minutes}分钟</span></label>)}</div></> : <><Field label="餐次"><select value={change.slot} onChange={e => setChange({
              ...change,
              slot: e.target.value,
              recipeId: allowed.find(r => r.meal === (e.target.value === 'breakfast' ? 'breakfast' : 'main'))?.id || ''
            })}>{['breakfast', 'lunch', 'dinner'].map(s => <option key={s} value={s}>{mealName[s]}</option>)}</select></Field><Field label="替换菜谱"><select value={change.recipeId} onChange={e => setChange({
              ...change,
              recipeId: e.target.value
            })}>{allowed.filter(r => r.meal === (change.slot === 'breakfast' ? 'breakfast' : 'main')).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field><Field label="人数"><input type="number" min="1" max="8" required value={change.servings} onChange={e => setChange({
              ...change,
              servings: Number(e.target.value)
            })} /></Field></>}<p className="health-help">会重新核对时间、器材、过敏和近期感受。调整后仍需确认启用。</p><button type="submit" className="primary" disabled={busy}>生成调整草案</button></form></Modal>}
 </div>;
}
function StockItem({
  item,
  saved,
  save,
  busy
}) {
  const [checked, setChecked] = useState(saved);
  useEffect(() => setChecked(saved), [saved]);
  return <label><input type="checkbox" checked={checked} disabled={busy} onChange={async e => {
      const next = e.target.checked;
      setChecked(next);
      if (!(await save(next))) setChecked(saved);
    }} /><span>{item.name}</span><b>{item.grams} 克</b></label>;
}
function Recipe({
  recipe,
  servings,
  foods = []
}) {
  const names = Object.fromEntries(foods.map(f => [f.id, f.name]));
  const nutritionLabels = {
    kcal: '能量（千卡）',
    protein: '蛋白质（克）',
    fat: '脂肪（克）',
    carbs: '碳水（克）',
    fiber: '膳食纤维（克）',
    sodium: '钠（毫克）'
  };
  return <div className="health-recipe"><p>{recipe.minutes} 分钟 · {servings} 人份 · {recipe.budget}</p><h4>食材（生重，可食部分）</h4><ul>{recipe.ingredients.map(i => <li key={i.foodId}>{names[i.foodId] || i.foodId} · {Math.round(i.grams * servings)} 克</li>)}</ul><h4>做法</h4><ol>{recipe.steps.map(s => <li key={s}>{s}</li>)}</ol><details><summary>整份营养估算与来源</summary>{Object.entries(recipe.nutrition).map(([k, v]) => <p key={k}>{nutritionLabels[k]}：{Math.round(v * servings * 10) / 10}</p>)}<p>按所列食材计算；额外调料未包含，实际份量、品牌和制作方式会影响结果。</p><a href="https://fdc.nal.usda.gov/download-datasets/" target="_blank" rel="noreferrer">USDA SR Legacy 数据集</a>{recipe.sources.map((s, i) => <a key={s} href={s} target="_blank" rel="noreferrer">食材 {i + 1}</a>)}</details></div>;
}
function Profile({
  profile,
  reports,
  catalog,
  client,
  run,
  busy,
  setModal
}) {
  const [form, setForm] = useState(() => ({
      ...emptyProfile,
      ...profile?.payload
    })),
    [file, setFile] = useState(null),
    [uploadConsent, setUploadConsent] = useState(false),
    [allergyText, setAllergyText] = useState(listText(profile?.payload.allergies)),
    [dislikeText, setDislikeText] = useState(listText(profile?.payload.dislikes));
  const set = (k, v) => setForm(f => ({
    ...f,
    [k]: v
  }));
  async function upload() {
    if (!file || !uploadConsent) return;
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    run(() => client.importReport({
      filename: file.name,
      dataBase64,
      consent: true,
      idempotencyKey: healthIdempotencyKey()
    }), '报告已导入，请逐项核对后确认。');
  }
  return <div className="health-page"><section className="health-hero compact"><div><p>本人健康档案</p><h2>由你决定保存什么、AI 能使用什么</h2><span>健康资料加密保存在当前服务中。你可以查看、导出或删除。</span></div></section><form className="health-profile" onSubmit={e => {
      e.preventDefault();
      run(() => client.saveProfile({
        payload: {
          ...form,
          allergies: csv(allergyText),
          dislikes: csv(dislikeText)
        },
        revision: profile?.revision,
        idempotencyKey: healthIdempotencyKey()
      }), '健康档案已保存。');
    }}><section><h2>数据与 AI 同意</h2><label className="health-switch"><input type="checkbox" checked={form.consentStorage} onChange={e => set('consentStorage', e.target.checked)} /><span><b>允许在当前服务加密保存健康资料</b><small>关闭后停止新增和修改，仍可查看、导出和删除。</small></span></label><label className="health-switch"><input type="checkbox" checked={form.consentAI} onChange={e => set('consentAI', e.target.checked)} /><span><b>允许 AI 使用我选择的资料生成草案</b><small>开启后，将本次计划所需的目标、偏好和少量执行统计交给AI服务处理；可随时关闭。</small></span></label></section><section><h2>偏好与目标</h2><div className="health-form-row"><Field label="自愿目标"><select value={form.goal} onChange={e => set('goal', e.target.value)}>{Object.entries(goalName).map(([v, n]) => <option value={v} key={v}>{n}</option>)}</select></Field><Field label="经验"><select value={form.experience} onChange={e => set('experience', e.target.value)}><option value="beginner">刚开始</option><option value="regular">有规律运动</option></select></Field><Field label="每周天数"><input type="number" min="1" max="7" value={form.daysPerWeek} onChange={e => set('daysPerWeek', Number(e.target.value))} /></Field><Field label="每次分钟"><input type="number" min="5" max="120" value={form.minutesPerSession} onChange={e => set('minutesPerSession', Number(e.target.value))} /></Field></div><div className="health-form-row"><Field label="日常做饭人数"><input type="number" min="1" max="8" value={form.servings} onChange={e => set('servings', Number(e.target.value))} /></Field><Field label="每餐烹饪分钟"><input type="number" min="5" max="120" value={form.cookingMinutes} onChange={e => set('cookingMinutes', Number(e.target.value))} /></Field></div><Field label="可用器材"><div className="health-choice">{[['chair', '椅子'], ['wall', '墙面'], ['dumbbells', '哑铃']].map(([v, n]) => <label key={v}><input type="checkbox" checked={form.equipment.includes(v)} onChange={e => set('equipment', e.target.checked ? [...form.equipment, v] : form.equipment.filter(x => x !== v))} /><span>{n}</span></label>)}</div></Field><Field label="过敏（用逗号分隔）" hint="未知过敏词会暂停自动推荐，等待你明确核对。"><input value={allergyText} onChange={e => setAllergyText(e.target.value)} placeholder="例如：花生、蛋、乳" /></Field><Field label="不喜欢的食物"><input value={dislikeText} onChange={e => setDislikeText(e.target.value)} /></Field><Field label="其他限制"><textarea value={form.restrictions} onChange={e => set('restrictions', e.target.value)} /></Field></section><section><h2>生成前必须由本人确认</h2>{[['adult', '我是成年人'], ['pregnant', '处于孕期'], ['medicalDiet', '正在执行治疗性饮食']].map(([k, n]) => <Field label={n} key={k}><select value={form[k] === undefined ? 'unknown' : String(form[k])} onChange={e => set(k, e.target.value === 'unknown' ? undefined : e.target.value === 'true')}><option value="unknown">暂不填写</option><option value="true">是</option><option value="false">否</option></select></Field>)}</section><div className="health-actions"><button type="submit" className="primary" disabled={busy}>{busy ? '保存中…' : '保存本人档案'}</button></div></form><section><header className="health-section-head"><div><small>REPORTS</small><h2>健康报告</h2></div></header><div className="health-upload"><Field label="选择 PDF（不超过 8MB）"><input type="file" accept="application/pdf,.pdf" onChange={e => setFile(e.target.files[0] || null)} /></Field><label className="health-switch"><input type="checkbox" checked={uploadConsent} onChange={e => setUploadConsent(e.target.checked)} /><span><b>同意为本次健康报告核对上传此 PDF</b><small>导入后仍需核对机构、日期、项目、数值、单位、范围和页码。</small></span></label><button type="button" disabled={busy || !file || !uploadConsent || file?.size > 8 * 1024 * 1024} onClick={upload}>导入并识别</button>{file?.size > 8 * 1024 * 1024 && <p role="alert">文件超过 8MB，请选择较小的 PDF。</p>}</div>{reports.length ? <div className="health-list">{reports.map(r => <article key={r.id}><button type="button" className="health-list-main" onClick={() => setModal({
            kind: 'report',
            record: r
          })}><span><strong>{r.payload.filename}</strong><small>{r.payload.status === 'unrecognized' ? '未识别，可手动记录' : r.payload.status === 'review' ? '等待本人核对' : '已核对归档'}</small></span></button><a href={client.reportFileUrl(r.id)} target="_blank" rel="noreferrer">查看原文件</a><button type="button" disabled={busy} onClick={() => {
            if (globalThis.confirm('确认删除这份健康报告及其原文件？')) run(() => client.removeRecord(r.id, r.revision), '报告及原文件已删除。');
          }}>删除</button></article>)}</div> : <Empty title="还没有健康报告">导入 PDF 后，识别内容会先进入核对状态。</Empty>}</section><section className="health-data-actions"><h2>我的健康资料</h2><p className="health-help">导出包含记录及报告文字；原 PDF 可在报告旁单独下载。删除健康资料不删除主对话原始消息。后续普通AI聊天不会再次使用健康记录。</p><button type="button" onClick={() => run(async () => jsonDownload(await client.exportAll(), `AI分身-健康资料-${localDay()}.json`), '健康资料导出文件已生成。')}>导出记录</button><button type="button" className="danger" onClick={() => {
        if (globalThis.confirm('确认删除本人全部健康资料及关联提醒？不会删除账号、日记及主对话中你输入的原始消息；原消息可在对话管理中删除。删除后无法恢复。')) run(() => client.deleteAll(), '本人健康资料已全部删除。');
      }}>删除全部健康资料</button></section></div>;
}
function ReportReview({
  record,
  client,
  close,
  run,
  busy
}) {
  const p = record.payload,
    [examDate, setExamDate] = useState(p.examDate || ''),
    [institution, setInstitution] = useState(p.institution || ''),
    [items, setItems] = useState(p.items || []);
  const setItem = (i, k, v) => setItems(a => a.map((x, n) => n === i ? {
    ...x,
    [k]: k === 'pageNumber' ? Number(v) : v
  } : x));
  return <Modal title="核对健康报告" onClose={close} wide><form className="health-form" onSubmit={e => {
      e.preventDefault();
      run(() => client.confirmReport(record.id, {
        revision: record.revision,
        examDate,
        institution,
        items,
        confirmedSelf: true
      }), '报告已由本人核对并归档。');
    }}><p className="health-help">请对照原文件逐项核对。系统不会把识别结果解释为诊断。</p><a href={client.reportFileUrl(record.id)} target="_blank" rel="noreferrer">打开原 PDF 核对</a><div className="health-form-row"><Field label="检查日期"><input required type="date" value={examDate} onChange={e => setExamDate(e.target.value)} /></Field><Field label="机构"><input required value={institution} onChange={e => setInstitution(e.target.value)} /></Field></div>{p.status === 'unrecognized' && <p className="health-caution">文件内容未能识别。你可以对照原 PDF 手动添加项目。</p>}{items.map((item, i) => <fieldset className="health-report-item" key={i}><legend>项目 {i + 1}</legend>{['name', 'value', 'unit', 'reference', 'flag', 'pageNumber'].map(k => <Field key={k} label={{
          name: '项目',
          value: '数值',
          unit: '单位',
          reference: '参考范围',
          flag: '原文标记',
          pageNumber: '页码'
        }[k]}><input required={['name', 'value', 'unit', 'pageNumber'].includes(k)} type={k === 'pageNumber' ? 'number' : 'text'} min={k === 'pageNumber' ? 1 : undefined} value={item[k] ?? ''} onChange={e => setItem(i, k, e.target.value)} /></Field>)}<button type="button" onClick={() => setItems(a => a.filter((_, n) => n !== i))}>移除此项</button></fieldset>)}<button type="button" onClick={() => setItems(a => [...a, {
        name: '',
        value: '',
        unit: '',
        reference: '',
        flag: '',
        pageNumber: 1
      }])}>＋ 手动添加项目</button><div className="health-actions"><button type="button" onClick={close}>稍后核对</button><button type="submit" className="primary" disabled={busy}>确认是本人的报告并归档</button></div></form></Modal>;
}
