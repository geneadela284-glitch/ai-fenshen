import { useEffect, useMemo, useState } from 'react';
import { createFinanceClient, openCurrentMonthPdf } from './financeClient.js';
import { createFinanceViewState } from './financeF201State.js';
import { customDateRange, financeEntryState, financeRevisionLabel, groupFinanceEntriesByDate } from './financeF201Ui.js';

const EXPENSE_CATEGORIES = ['餐饮', '交通', '购物', '居家', '娱乐', '医疗', '教育', '人情', '宠物', '旅行', '其他'];
const INCOME_CATEGORIES = ['工资', '经营', '客户回款', '退款', '转入', '其他收入'];

function money(value) {
  return `¥${((Number(value) || 0) / 100).toFixed(2)}`;
}

function toMinor(value) {
  const match = String(value || '').trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

function entryDateTime(entry) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: entry.timezone || 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(entry.occurredAt));
  } catch {
    return '时间待确认';
  }
}

function mutationErrorMessage(error) {
  if (error?.code === 'VERSION_CONFLICT') return '账本已在其他位置更新，请重新查询后再修改。';
  if (error?.code === 'IDEMPOTENCY_CONFLICT') return '本次请求与上次内容不一致，请重新打开账目。';
  if (error?.code === 'NETWORK_ERROR') return '网络异常，未保存的修改仍保留，可稍后重试。';
  if (error?.code === 'STORAGE_UNAVAILABLE') return '账本暂时不可用，未保存的修改仍保留。';
  if (error?.code === 'AUTH_REQUIRED') return '登录状态已失效，请重新登录后再试。';
  if (error?.code === 'NOT_FOUND') return '这笔账不存在或已不可访问。';
  return '操作没有完成，请稍后重试。';
}

function queryErrorMessage(errorState) {
  if (errorState === 'auth_required') return '登录状态已失效，请重新登录。';
  if (errorState === 'storage_unavailable') return '账本暂时不可用，请稍后重试。';
  if (errorState === 'network_error') return '网络异常，账目没有加载。';
  return '账目暂时无法读取，请稍后重试。';
}

export default function FinanceView({ onBack, onStartConversation, financeF201Enabled = false }) {
  const client = useMemo(() => createFinanceClient(), []);
  const viewState = useMemo(() => createFinanceViewState({
    financeF201Enabled,
    client
  }), [client, financeF201Enabled]);

  if (viewState.mode === 'f201') {
    return (
      <FinanceF201View
        client={client}
        page={viewState.page}
        onBack={onBack}
        onStartConversation={onStartConversation}
      />
    );
  }
  return <LegacyFinanceView client={client} onBack={onBack} />;
}

function LegacyFinanceView({ client, onBack }) {
  const [overview, setOverview] = useState({ summary: {}, entries: [], capabilities: {} });
  const [selected, setSelected] = useState(null);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('正在读取账本…');
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);

  const refresh = async () => {
    setStatus('正在读取账本…');
    try {
      const next = await client.getOverview();
      setOverview(next);
      setStatus('');
      if (selected) setSelected(next.entries.find((entry) => entry.id === selected.id) || null);
    } catch {
      setStatus('暂时无法读取账本，请稍后再试。');
    }
  };

  useEffect(() => { void refresh(); }, []);

  const openEntry = (entry) => {
    setSelected(entry);
    setAmount((entry.amountMinor / 100).toFixed(2));
    setCategory(entry.category);
  };

  const changeAmount = (value) => {
    setAmount(value);
  };

  const changeCategory = (value) => {
    setCategory(value);
  };

  const closeEntry = () => {
    setSelected(null);
  };

  const returnToHome = () => {
    onBack?.();
  };

  const save = async () => {
    const amountMinor = toMinor(amount);
    if (!selected || !amountMinor) {
      setStatus('请输入正确金额。');
      return;
    }
    try {
      await client.updateEntry(selected.id, { amountMinor, category });
      setSelected(null);
      await refresh();
      setStatus('已修改');
    } catch {
      setStatus('这笔账暂时没有修改成功，请重试。');
    }
  };

  const remove = async () => {
    if (!selected || !window.confirm('确认删除这笔账吗？')) return;
    try {
      await client.deleteEntry(selected.id);
      setSelected(null);
      await refresh();
      setStatus('已删除');
    } catch {
      setStatus('这笔账暂时没有删除成功，请重试。');
    }
  };

  const exportReport = async (format) => {
    setExportBusy(true);
    if (format === 'pdf') {
      setExportOpen(false);
      setStatus('正在打开PDF…');
      try {
        openCurrentMonthPdf();
        setStatus('PDF已开始打开');
      } catch {
        setStatus('PDF暂时无法打开，请稍后再试。');
      } finally {
        setExportBusy(false);
      }
      return;
    }
    setStatus('正在生成报表…');
    try {
      const report = await client.downloadCurrentMonthReport(format);
      const file = typeof File === 'function'
        ? new File([report.blob], report.filename, { type: report.contentType })
        : null;
      const supportsIosFileShare = /iPhone|iPad/.test(navigator.userAgent || '')
        && file
        && navigator.share
        && navigator.canShare?.({ files: [file] });
      if (supportsIosFileShare) {
        await navigator.share({ files: [file], title: report.filename });
      } else {
        const url = URL.createObjectURL(report.blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = report.filename;
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      setExportOpen(false);
      setStatus('报表已生成');
    } catch (error) {
      if (error?.name === 'AbortError') setStatus('');
      else setStatus('报表暂时无法生成，请稍后再试。');
    } finally {
      setExportBusy(false);
    }
  };

  const summary = overview.summary || {};
  return (
    <section className="af-finance-view" aria-label="个人财务账本" data-finance-mode="legacy">
      <button type="button" className="af-finance-back" onClick={returnToHome} aria-label="返回首页">←</button>
      <header className="af-finance-header">
        <p>PERSONAL LEDGER</p>
        <h1>财务</h1>
        <button type="button" onClick={() => void refresh()}>重新查询</button>
      </header>

      <div className="af-finance-summary" aria-label="本月收支汇总">
        <article className="is-income"><span>本月收入</span><strong>{money(summary.incomeMinor)}</strong></article>
        <article className="is-expense"><span>本月支出</span><strong>{money(summary.expenseMinor)}</strong></article>
        <article className="is-balance"><span>本月结余</span><strong>{money(summary.balanceMinor)}</strong></article>
      </div>

      <section className="af-finance-tools" aria-label="财务工具">
        <button type="button" className="af-finance-export-button" onClick={() => setExportOpen(true)} disabled={exportBusy}>
          <span>导出本月报表</span><small>PDF 或 Excel</small>
        </button>
        <div className="af-finance-future-grid">
          <article>
            <strong>财务状况</strong>
            <p>{overview.capabilities?.financial_position?.message || '当前仅基于收支账本，完整资产负债分析尚未启用。'}</p>
          </article>
          <article aria-disabled="true">
            <strong>AI财务分析</strong>
            <p>未启用</p>
          </article>
        </div>
      </section>

      <div className="af-finance-list-heading">
        <h2>最近10笔账</h2>
        <span>{overview.entries.length} 笔</span>
      </div>
      <div className="af-finance-list">
        {overview.entries.map((entry) => (
          <button type="button" className={`af-finance-entry is-${entry.type}`} key={entry.id} onClick={() => openEntry(entry)}>
            <span className="af-finance-entry-category">{entry.category}</span>
            <span className="af-finance-entry-date">{new Date(entry.occurredAt).toLocaleDateString('zh-CN', { timeZone: entry.timezone })}</span>
            <strong>{entry.type === 'expense' ? '-' : '+'}{money(entry.amountMinor)}</strong>
          </button>
        ))}
        {!overview.entries.length && !status ? <p className="af-finance-empty">还没有账目，可以直接在对话中说“早餐18元”。</p> : null}
      </div>

      {selected ? (
        <div className="af-finance-detail" role="dialog" aria-modal="true" aria-label="账目详情">
          <div className="af-finance-detail-card">
            <div><h2>账目详情</h2><button type="button" onClick={closeEntry} aria-label="关闭详情">×</button></div>
            <label>金额（元）<input inputMode="decimal" value={amount} onChange={(event) => changeAmount(event.target.value)} /></label>
            <label>分类<select value={category} onChange={(event) => changeCategory(event.target.value)}>
              {(selected.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map((item) => <option key={item}>{item}</option>)}
            </select></label>
            <p>{selected.note || '无备注'}</p>
            <div className="af-finance-detail-actions">
              <button type="button" onClick={() => void save()}>修改</button>
              <button type="button" className="is-danger" onClick={() => void remove()}>删除</button>
            </div>
          </div>
        </div>
      ) : null}
      {exportOpen ? (
        <div className="af-finance-export-sheet" role="dialog" aria-modal="true" aria-label="导出本月报表">
          <div className="af-finance-export-card">
            <h2>导出本月报表</h2>
            <button type="button" disabled={exportBusy} onClick={() => void exportReport('pdf')}>导出PDF</button>
            <button type="button" disabled={exportBusy} onClick={() => void exportReport('xlsx')}>导出Excel</button>
            <button type="button" disabled={exportBusy} className="is-cancel" onClick={() => setExportOpen(false)}>取消</button>
          </div>
        </div>
      ) : null}
      {status ? <p className="af-finance-status" role="status">{status}</p> : null}
    </section>
  );
}

function FinanceF201View({ client, page, onBack, onStartConversation }) {
  const allCategories = useMemo(() => [...new Set([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES])], []);
  const timezone = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'; } catch { return 'Asia/Shanghai'; }
  }, []);
  const [overview, setOverview] = useState({ summary: {}, entries: [], capabilities: {} });
  const [dashboardState, setDashboardState] = useState('loading');
  const [pageState, setPageState] = useState(() => page.getState());
  const [selected, setSelected] = useState(null);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState({
    period: 'all_time',
    type: '',
    categories: [],
    status: 'active',
    startDate: '',
    endDate: ''
  });
  const [notice, setNotice] = useState('');

  const syncPage = () => {
    const next = page.getState();
    setPageState({ ...next });
    return next;
  };

  const loadDashboard = async () => {
    setDashboardState('loading');
    try {
      setOverview(await client.getOverview());
      setDashboardState('success');
    } catch {
      setDashboardState('error');
    }
  };

  const loadHistory = async () => {
    setNotice('');
    try {
      const loading = page.loadHistory();
      syncPage();
      await loading;
      syncPage();
    } catch (error) {
      syncPage();
      setNotice(error?.code === 'NETWORK_ERROR' ? '网络异常，历史账目暂时无法读取。' : '历史账目暂时无法读取。');
    }
  };

  useEffect(() => {
    void loadDashboard();
    void loadHistory();
  }, [client, page]);

  const returnToHome = () => {
    if (page.shouldConfirmLeave() && !window.confirm('这笔账还有未保存的修改，确认返回吗？')) return;
    onBack?.();
  };

  const togglePrivacy = () => {
    page.togglePrivacyAmounts();
    syncPage();
  };

  const applyFilters = async () => {
    let dateFilters = { period: filterDraft.period, startAt: null, endAt: null };
    if (filterDraft.period === 'custom') {
      dateFilters = customDateRange(filterDraft.startDate, filterDraft.endDate, timezone);
      if (!dateFilters) {
        setNotice('请选择有效的自定义日期范围。');
        return;
      }
    }
    page.setFilters({
      ...dateFilters,
      timezone,
      types: filterDraft.type ? [filterDraft.type] : [],
      categories: filterDraft.categories,
      statuses: filterDraft.status === 'all'
        ? ['active', 'archived']
        : [filterDraft.status]
    });
    syncPage();
    setFilterOpen(false);
    await loadHistory();
  };

  const toggleCategory = (value) => {
    setFilterDraft((current) => ({
      ...current,
      categories: current.categories.includes(value)
        ? current.categories.filter((item) => item !== value)
        : [...current.categories, value]
    }));
  };

  const openEntry = async (entry) => {
    setSelected(entry);
    setAmount((entry.amountMinor / 100).toFixed(2));
    setCategory(entry.category || '其他');
    setNote(entry.note || '');
    page.openDraft(entry);
    syncPage();
    try {
      const loading = page.loadRevisions(entry.id);
      syncPage();
      await loading;
      syncPage();
    } catch (error) {
      syncPage();
      setNotice(mutationErrorMessage(error));
    }
  };

  const closeEntry = () => {
    if (page.shouldConfirmLeave() && !window.confirm('这笔账还有未保存的修改，确认离开吗？')) return;
    page.discardDraft();
    syncPage();
    setSelected(null);
  };

  const changeDraft = (patch) => {
    page.changeDraft(patch);
    syncPage();
  };

  const save = async () => {
    const amountMinor = toMinor(amount);
    if (!amountMinor) {
      setNotice('请输入正确金额。');
      return;
    }
    changeDraft({ amountMinor, category, note });
    let updated;
    try {
      updated = await page.saveDraft();
    } catch (error) {
      syncPage();
      setNotice(mutationErrorMessage(error));
      return;
    }
    syncPage();
    setSelected(updated);
    setNotice('修改已保存。');
    await loadDashboard();
    try {
      await page.loadHistory();
      await page.loadRevisions(updated.id);
      syncPage();
    } catch {
      syncPage();
      setNotice('修改已保存，但最新列表暂时无法刷新。');
    }
  };

  const lifecycle = async (operation) => {
    if (!selected) return;
    if (operation === 'delete' && !window.confirm('删除后可在筛选面板中查看并恢复，确认删除吗？')) return;
    const method = {
      delete: 'deleteEntry',
      restore: 'restoreEntry',
      archive: 'archiveEntry',
      unarchive: 'unarchiveEntry'
    }[operation];
    let updated;
    try {
      updated = await page[method](selected);
    } catch (error) {
      syncPage();
      setNotice(mutationErrorMessage(error));
      return;
    }
    const successNotice = { delete: '已删除，可从已删除筛选中恢复。', restore: '账目已恢复。', archive: '账目已归档。', unarchive: '账目已取消归档。' }[operation];
    syncPage();
    setSelected(updated);
    setAmount((updated.amountMinor / 100).toFixed(2));
    setCategory(updated.category || '其他');
    setNote(updated.note || '');
    setNotice(successNotice);
    await loadDashboard();
    try {
      await page.loadHistory();
      await page.loadRevisions(updated.id);
      syncPage();
    } catch {
      syncPage();
      setNotice(`${successNotice} 最新列表暂时无法刷新。`);
    }
  };

  const loadMore = async () => {
    try {
      const loading = page.loadNextPage();
      syncPage();
      await loading;
      syncPage();
    } catch (error) {
      syncPage();
      setNotice(mutationErrorMessage(error));
    }
  };

  const summary = overview.summary || {};
  const amountsHidden = pageState.privacy.amountsHidden;
  const displayMoney = (value) => amountsHidden ? '¥ ••••' : money(value);
  const groups = groupFinanceEntriesByDate(pageState.query.entries);
  const selectedState = financeEntryState(selected || {});

  return (
    <section className="af-finance-view af-finance-f201" aria-label="个人财务驾驶舱" data-finance-mode="f201">
      <button type="button" className="af-finance-back" onClick={returnToHome} aria-label="返回AI分身首页">←</button>
      <button type="button" className="af-finance-privacy-toggle" onClick={togglePrivacy} aria-pressed={amountsHidden}>
        {amountsHidden ? '显示金额' : '隐藏金额'}
      </button>

      <header className="af-finance-f201-header">
        <p>PERSONAL FINANCE</p>
        <h1>个人财务驾驶舱</h1>
        <span>数字来自可信账本</span>
      </header>

      <section className="af-finance-f201-dashboard" aria-label="本月财务状态" aria-busy={dashboardState === 'loading'}>
        {dashboardState === 'error' ? (
          <div className="af-finance-f201-error" role="alert">
            <strong>财务状态暂时无法读取</strong>
            <button type="button" onClick={() => void loadDashboard()}>重试</button>
          </div>
        ) : (
          <div className="af-finance-f201-metrics">
            <article className="is-income"><span>本月收入</span><strong>{dashboardState === 'loading' ? '读取中' : displayMoney(summary.incomeMinor)}</strong></article>
            <article className="is-expense"><span>本月支出</span><strong>{dashboardState === 'loading' ? '读取中' : displayMoney(summary.expenseMinor)}</strong></article>
            <article className="is-balance"><span>本月结余</span><strong>{dashboardState === 'loading' ? '读取中' : displayMoney(summary.balanceMinor)}</strong></article>
          </div>
        )}
        <button type="button" className="af-finance-ai-entry" onClick={onStartConversation}>
          <span><small>AI财务摘要入口</small><strong>询问 AI分身</strong></span>
          <span aria-hidden="true">↗</span>
          <em>回到统一对话，例如“这个月为什么花多了？”</em>
        </button>
      </section>

      <section className="af-finance-history" aria-label="历史账目">
        <div className="af-finance-history-heading">
          <div><p>TRUSTED TIMELINE</p><h2>历史账目</h2></div>
          <button type="button" onClick={() => setFilterOpen((open) => !open)} aria-expanded={filterOpen}>筛选账目</button>
        </div>

        {filterOpen ? (
          <div className="af-finance-filter-panel" aria-label="筛选账目">
            <label>日期
              <select value={filterDraft.period} onChange={(event) => setFilterDraft({ ...filterDraft, period: event.target.value })}>
                <option value="all_time">全部时间</option><option value="today">今天</option><option value="yesterday">昨天</option>
                <option value="this_week">本周</option><option value="this_month">本月</option><option value="last_year">去年</option>
                <option value="custom">自定义日期</option>
              </select>
            </label>
            {filterDraft.period === 'custom' ? (
              <div className="af-finance-custom-dates"><label>开始日期<input type="date" value={filterDraft.startDate} onChange={(event) => setFilterDraft({ ...filterDraft, startDate: event.target.value })} /></label><label>结束日期<input type="date" value={filterDraft.endDate} onChange={(event) => setFilterDraft({ ...filterDraft, endDate: event.target.value })} /></label></div>
            ) : null}
            <label>类型
              <select value={filterDraft.type} onChange={(event) => setFilterDraft({ ...filterDraft, type: event.target.value })}>
                <option value="">全部类型</option><option value="expense">支出</option><option value="income">收入</option>
              </select>
            </label>
            <label>状态
              <select value={filterDraft.status} onChange={(event) => setFilterDraft({ ...filterDraft, status: event.target.value })}>
                <option value="active">正常</option><option value="archived">已归档</option><option value="deleted">已删除</option><option value="all">正常与归档</option>
              </select>
            </label>
            <fieldset><legend>多选分类</legend><div className="af-finance-category-chips">{allCategories.map((item) => <label className={filterDraft.categories.includes(item) ? 'is-selected' : ''} key={item}><input type="checkbox" checked={filterDraft.categories.includes(item)} onChange={() => toggleCategory(item)} />{item}</label>)}</div></fieldset>
            <button type="button" className="af-finance-apply-filter" onClick={() => void applyFilters()}>应用筛选</button>
          </div>
        ) : null}

        {pageState.query.status === 'loading' && !pageState.query.entries.length ? <div className="af-finance-history-state" role="status"><span className="af-finance-spinner" />正在读取账目…</div> : null}
        {pageState.query.status === 'error' && !pageState.query.entries.length ? <div className="af-finance-history-state is-error" role="alert"><strong>{queryErrorMessage(pageState.query.errorState)}</strong><button type="button" onClick={() => void loadHistory()}>重新加载</button></div> : null}
        {pageState.query.status !== 'loading' && !pageState.query.entries.length ? <div className="af-finance-history-state"><strong>这里还没有账目</strong><p>可以回到统一对话，说“早餐18元”。</p></div> : null}

        <div className="af-finance-timeline">
          {groups.map((group) => <section className="af-finance-date-group" key={group.key} aria-labelledby={`finance-date-${group.key}`}>
            <h3 id={`finance-date-${group.key}`}>{group.label}<span>{group.entries.length} 笔</span></h3>
            <div>{group.entries.map((entry) => {
              const state = financeEntryState(entry);
              return <button type="button" className={`af-finance-timeline-card is-${entry.type} is-${state}`} key={entry.id} onClick={() => void openEntry(entry)}>
                <span className="af-finance-category-mark" aria-hidden="true" />
                <span className="af-finance-timeline-copy"><strong>{entry.merchant || entry.category}</strong><small>{entryDateTime(entry)} · {entry.category} · {entry.sourceMessageId ? '对话记录' : '手动记录'}</small></span>
                <span className="af-finance-timeline-amount">{amountsHidden ? '¥ ••••' : `${entry.type === 'expense' ? '-' : '+'}${money(entry.amountMinor)}`}<small>{state === 'archived' ? '已归档' : state === 'deleted' ? '已删除' : '已确认'}</small></span>
              </button>;
            })}</div>
          </section>)}
        </div>
        {pageState.query.hasMore ? <button type="button" className="af-finance-load-more" disabled={pageState.query.status === 'loading'} onClick={() => void loadMore()}>{pageState.query.status === 'loading' ? '正在加载…' : '加载更多'}</button> : null}
      </section>

      {selected ? (
        <div className="af-finance-detail af-finance-f201-detail" role="dialog" aria-modal="true" aria-label="账目详情">
          <div className="af-finance-detail-card">
            <div><div><small>账目详情</small><h2>{selected.merchant || selected.category}</h2></div><button type="button" onClick={closeEntry} aria-label="关闭详情">×</button></div>
            <span className={`af-finance-entry-state is-${selectedState}`}>{selectedState === 'deleted' ? '已删除' : selectedState === 'archived' ? '已归档' : '已确认'}</span>
            <label>金额（元）<input inputMode="decimal" value={amount} disabled={selectedState === 'deleted'} onChange={(event) => { setAmount(event.target.value); const value = toMinor(event.target.value); if (value !== null) changeDraft({ amountMinor: value }); }} /></label>
            <label>分类<select value={category} disabled={selectedState === 'deleted'} onChange={(event) => { setCategory(event.target.value); changeDraft({ category: event.target.value }); }}>{(selected.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map((item) => <option key={item}>{item}</option>)}</select></label>
            <label>备注<textarea value={note} disabled={selectedState === 'deleted'} onChange={(event) => { setNote(event.target.value); changeDraft({ note: event.target.value }); }} /></label>
            {pageState.draft.dirty ? <p className="af-finance-unsaved" role="status">未保存 · 返回前会提醒你</p> : null}
            {pageState.mutation.conflict === 'version' ? <p className="af-finance-conflict" role="alert">账本已在其他位置更新，请重新查询后再修改。</p> : null}
            <div className="af-finance-detail-actions">
              {selectedState !== 'deleted' ? <button type="button" disabled={pageState.mutation.status === 'loading' || !pageState.draft.dirty} onClick={() => void save()}>保存修改</button> : null}
              {selectedState === 'deleted' ? <button type="button" onClick={() => void lifecycle('restore')}>恢复</button> : <button type="button" className="is-danger" onClick={() => void lifecycle('delete')}>删除</button>}
              {selectedState === 'active' ? <button type="button" onClick={() => void lifecycle('archive')}>归档</button> : null}
              {selectedState === 'archived' ? <button type="button" onClick={() => void lifecycle('unarchive')}>取消归档</button> : null}
            </div>
            <section className="af-finance-revisions" aria-label="修改记录">
              <h3>修改记录</h3>
              {pageState.revisions.status === 'loading' ? <p>正在读取…</p> : null}
              {pageState.revisions.status === 'error' ? <p>修改记录暂时无法读取。</p> : null}
              {pageState.revisions.status === 'success' && !pageState.revisions.items.length ? <p>暂无修改记录</p> : null}
              <ol>{pageState.revisions.items.map((revision) => <li key={revision.id}><span /><div><strong>{financeRevisionLabel(revision)}</strong><small>{new Date(revision.createdAt).toLocaleString('zh-CN')} · 版本 {revision.entryVersion}</small><p>{Object.keys(revision.changes || {}).filter((field) => !['version', 'updatedAt'].includes(field)).join('、') || '状态已更新'}</p></div></li>)}</ol>
            </section>
          </div>
        </div>
      ) : null}

      {notice ? <p className="af-finance-status" role="status">{notice}</p> : null}
    </section>
  );
}
