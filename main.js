import * as echarts from 'echarts';
import _ from 'lodash';
import dayjs from 'dayjs';
import * as XLSX from 'xlsx';
import { marked } from 'marked';

// --- 全局状态 ---
const API_BASE = 'http://127.0.0.1:3000/api';
let allTransactions = [];
let currentTheme = localStorage.getItem('theme') || 'dark';
if (!localStorage.getItem('theme')) localStorage.setItem('theme', 'dark');

let currentDrilldownData = [];
let hourlyRate = 0; // V7: 年度净时薪
let chatHistory = []; // V7: 对话历史

// 应用初始主题
document.documentElement.setAttribute('data-theme', currentTheme);

// --- Toast 通知 (V11) ---
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: 'check-circle', error: 'x-circle', info: 'info' };
    toast.innerHTML = `
        <i data-lucide="${icons[type]}" class="toast-icon"></i>
        <div class="toast-message">${message}</div>
    `;

    container.appendChild(toast);
    if (window.lucide) window.lucide.createIcons();

    setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// --- 初始化与事件绑定 ---
async function start() {
    await loadConfig(); // 先加载配置（含时薪）
    await refreshData();
    bindEvents();
    if (window.lucide) window.lucide.createIcons();
}

async function refreshData() {
    // 第一步：获取数据
    try {
        const res = await fetch(`${API_BASE}/bills`);
        if (!res.ok) throw new Error('后端响应异常');
        allTransactions = await res.json();
    } catch (e) {
        console.error('无法连接后端服务:', e);
        showToast('无法连接到后端服务', 'error');
        return; // 网络失败则不继续渲染
    }

    // 第二步：渲染数据（渲染错误不应被误报为网络问题）
    try {
        const cleanData = allTransactions.filter(t => t.status !== 'shadow');

        if (cleanData.length > 0) {
            renderDashboard(cleanData);
            renderGlobalTable(allTransactions);
            loadTagStats();
            hideEmptyState();
        } else {
            showEmptyState();
        }
    } catch (e) {
        console.error('渲染数据时出错:', e);
        showToast('数据渲染失败，请刷新重试', 'error');
    }
}

function bindEvents() {
    const setClick = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.onclick = fn;
    };

    // 导入
    const btnImport = document.getElementById('btn-import-trigger');
    const input = document.getElementById('file-input');
    if (btnImport && input) btnImport.onclick = () => input.click();
    if (input) input.onchange = (e) => handleFileUpload(e.target.files);

    // 设置弹窗
    setClick('btn-config', () => document.getElementById('config-modal').style.display = 'flex');
    setClick('btn-close-config', () => document.getElementById('config-modal').style.display = 'none');
    setClick('btn-save-config', saveConfig);
    setClick('btn-reset-db', resetDatabase);
    setClick('theme-toggle', toggleTheme);

    // 下钻弹窗通用关闭
    setClick('btn-close-drilldown', () => document.getElementById('drilldown-modal').style.display = 'none');

    // 背景点击关闭
    window.onclick = (e) => {
        if (e.target.classList.contains('modal')) e.target.style.display = 'none';
    };

    // V7: AI 导师对话绑定
    setClick('chat-bubble', () => {
        const win = document.getElementById('chat-window');
        win.style.display = win.style.display === 'flex' ? 'none' : 'flex';
    });
    setClick('btn-expand-chat', () => {
        const win = document.getElementById('chat-window');
        const btn = document.getElementById('btn-expand-chat');
        const isFull = win.classList.toggle('fullscreen');
        btn.innerHTML = isFull ? '<i data-lucide="minimize-2"></i>' : '<i data-lucide="maximize-2"></i>';
        if (window.lucide) window.lucide.createIcons();
    });
    setClick('btn-close-chat', () => {
        document.getElementById('chat-window').classList.remove('fullscreen');
        document.getElementById('chat-window').style.display = 'none';
        const btn = document.getElementById('btn-expand-chat');
        if (btn) btn.innerHTML = '<i data-lucide="maximize-2"></i>';
        if (window.lucide) window.lucide.createIcons();
    });
    setClick('btn-send-chat', sendChatMessage);
    setClick('btn-clear-chat', clearChat);
    document.getElementById('chat-input')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendChatMessage();
    });

    // V13: 标签系统事件
    setClick('btn-auto-tag', applyAutoTags);

    // 筛选器绑定
    ['global-search', 'modal-search', 'modal-sort', 'modal-platform'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', id === 'global-search'
            ? _.debounce((e) => searchGlobal(e.target.value), 300)
            : applyModalFilters
        );
    });

    setClick('btn-run-ai', runAIAnalysis);
}

// --- V7 AI 对话逻辑 ---

async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const btn = document.getElementById('btn-send-chat');
    const msg = input.value.trim();
    if (!msg || btn.disabled) return;

    appendMessage('user', msg);
    input.value = '';

    // 进入加载状态
    btn.disabled = true;
    const loadingId = 'loading-' + Date.now();
    appendMessage('bot', `<div id="${loadingId}"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>`);

    try {
        const res = await fetch(`${API_BASE}/ai/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, history: chatHistory })
        });
        const data = await res.json();
        const reply = data.content || '导师正在冥想，请稍后再问。';

        // 移除加载动画并显示真实回复
        const loadingEl = document.getElementById(loadingId);
        if (loadingEl) {
            loadingEl.parentElement.innerHTML = marked.parse(reply);
        }

        chatHistory.push({ role: 'user', content: msg }, { role: 'assistant', content: reply });
        if (chatHistory.length > 10) chatHistory = chatHistory.slice(-10);
    } catch (e) {
        const loadingEl = document.getElementById(loadingId);
        if (loadingEl) loadingEl.parentElement.innerText = '通讯中断，请检查设置。';
    } finally {
        btn.disabled = false;
        input.focus();
    }
}

function appendMessage(role, text) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.innerHTML = marked.parse(text);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function clearChat() {
    if (!confirm('确定要清空当前的对话上下文吗？')) return;
    chatHistory = [];
    const container = document.getElementById('chat-messages');
    if (container) {
        container.innerHTML = `<div class="msg bot">对话已清空。您可以开始新的咨询：</div>`;
    }
}

// --- 数据渲染层 ---

function renderGlobalTable(data) {
    const body = document.getElementById('global-bill-body');
    if (!body) return;

    // 默认按时间倒序
    const displayData = _.orderBy(data, ['time'], ['desc']).slice(0, 500);

    body.innerHTML = displayData.map(t => {
        const isShadow = t.status === 'shadow';
        const tags = t.tags || [];
        const tagsHtml = tags.length > 0
            ? tags.map(tag => `<span class="tag" style="font-size: 0.7rem; padding: 2px 6px; margin-right: 4px;">${tag}</span>`).join('')
            : '<span style="color: var(--text-dim); font-size: 0.7rem;">-</span>';

        return `
        <tr class="${isShadow ? 'row-shadow' : ''}">
            <td style="font-size: 0.75rem; color: var(--text-dim);">${dayjs(t.time).format('YYYY-MM-DD HH:mm')}</td>
            <td>
                <div style="font-weight: 600;">${t.peer}</div>
                <div style="font-size: 0.7rem; color: var(--text-dim);">${t.item}</div>
            </td>
            <td><span class="tag" style="background: rgba(128,128,128,0.1); border: 1px solid rgba(128,128,128,0.2);">${t.category}</span></td>
            <td>${tagsHtml}</td>
            <td>${isShadow ? '<span style="color:var(--text-dim); font-size:0.7rem; border:1px solid #999; padding:2px 4px; border-radius:4px;">内部流转</span>' : t.method}</td>
            <td style="text-align: right; color: ${isShadow ? 'var(--text-dim)' : 'var(--accent-primary)'}; font-family:'Outfit'; font-weight:700;">
                ${isShadow ? '<del>' : ''}¥${t.amount.toFixed(2)}${isShadow ? '</del>' : ''}
            </td>
        </tr>
    `}).join('');
}

// --- 空状态管理 (V11) ---
function showEmptyState() {
    const main = document.querySelector('main.dashboard-grid');
    if (!main) return;

    // 隐藏所有卡片
    main.classList.add('empty');
    main.innerHTML = `
        <div class="empty-state col-12" style="grid-column: 1 / -1;">
            <div class="empty-state-icon">📊</div>
            <div class="empty-state-title">尚未导入账单数据</div>
            <div class="empty-state-desc">
                请点击右上角的 <strong style="color: var(--accent-primary);">➕</strong> 按钮导入微信或支付宝账单。<br>
                支持 Excel 和 CSV 格式，可同时导入多个文件。
            </div>
            <button class="empty-state-action" onclick="document.getElementById('btn-import-trigger').click()">
                <i data-lucide="upload"></i>
                立即导入账单
            </button>
        </div>
    `;
    if (window.lucide) window.lucide.createIcons();
}

function hideEmptyState() {
    const main = document.querySelector('main.dashboard-grid');
    if (!main) return;
    main.classList.remove('empty');

    // 如果当前是空状态，需要重新加载完整的 HTML 结构
    if (main.querySelector('.empty-state')) {
        location.reload();
    }
}

function showDrilldown(title, list) {
    currentDrilldownData = list;
    document.getElementById('drilldown-title').innerText = title;
    document.getElementById('modal-search').value = '';
    document.getElementById('modal-platform').value = 'all';
    document.getElementById('modal-sort').value = 'time-desc';
    renderDrilldownList(list);
    document.getElementById('drilldown-modal').style.display = 'flex';
}

function applyModalFilters() {
    const keyword = document.getElementById('modal-search').value.toLowerCase();
    const sortVal = document.getElementById('modal-sort').value;
    const platform = document.getElementById('modal-platform').value;

    let filtered = currentDrilldownData.filter(t => {
        return (t.peer.toLowerCase().includes(keyword) || t.item.toLowerCase().includes(keyword)) &&
            (platform === 'all' || t.platform === platform);
    });

    if (sortVal === 'time-desc') filtered.sort((a, b) => b.time - a.time);
    if (sortVal === 'time-asc') filtered.sort((a, b) => a.time - b.time);
    if (sortVal === 'amount-desc') filtered.sort((a, b) => b.amount - a.amount);
    if (sortVal === 'amount-asc') filtered.sort((a, b) => a.amount - b.amount);

    renderDrilldownList(filtered);
}

function renderDrilldownList(list) {
    const el = document.getElementById('detail-list');
    if (!el) return;

    // V7: 插入生命成本列标题 (如果尚未插入)
    el.innerHTML = list.map(d => {
        // 计算生命耗时
        let lifeCost = '-';
        if (hourlyRate > 0) {
            const hours = d.amount / hourlyRate;
            lifeCost = hours < 0.1 ? '<0.1h' : `${hours.toFixed(1)}h`;
        }

        return `
        <div class="detail-item" style="grid-template-columns: 100px 1fr 80px 80px 80px;">
            <div style="font-size: 0.7rem; color: var(--text-dim);">${dayjs(d.time).format('MM-DD HH:mm')}</div>
            <div style="font-weight: 600;">${d.peer}<br><small style="font-weight:400; color:var(--text-dim)">${d.item}</small></div>
            <div style="text-align: center;"><span class="tag" style="background:${d.platform === 'wechat' ? '#07c16022' : '#1677ff22'}; color:${d.platform === 'wechat' ? '#07c160' : '#1677ff'}">${d.platform === 'wechat' ? '微' : '支'}</span></div>
            <div style="text-align: center; color: var(--accent-primary); font-family:'Outfit'; font-weight:700;">${lifeCost}</div>
            <div class="amount-val expense">¥${d.amount.toFixed(2)}</div>
        </div>
    `}).join('');
}

function searchGlobal(kw) {
    const k = kw.toLowerCase();
    const res = allTransactions.filter(t => t.peer.toLowerCase().includes(k) || t.item.toLowerCase().includes(k) || t.category.toLowerCase().includes(k));
    renderGlobalTable(res);
}

// --- 财务计算与图表 ---

function renderDashboard(data) {
    const cleanData = data.filter(d => d.status !== 'shadow');
    const wechat = _.sumBy(cleanData.filter(d => d.platform === 'wechat'), 'amount');
    const alipay = _.sumBy(cleanData.filter(d => d.platform === 'alipay'), 'amount');

    // 空值保护：确保元素存在再操作
    const elWechat = document.getElementById('stat-wechat');
    const elAlipay = document.getElementById('stat-alipay');
    const elTotal = document.getElementById('stat-total');

    if (elWechat) elWechat.innerText = `¥${wechat.toFixed(2)}`;
    if (elAlipay) elAlipay.innerText = `¥${alipay.toFixed(2)}`;
    if (elTotal) elTotal.innerText = `¥${(wechat + alipay).toFixed(2)}`;

    renderTrendChart(cleanData);
    renderCategoryChart(cleanData);
    renderMerchantChart(cleanData);
    renderSceneChart(cleanData);
    renderTimeHeatmap(cleanData);
    updateLoyaltyList(cleanData);

    // V9 新增诊断
    runLatteAudit(cleanData);
    runSubscriptionAudit(cleanData);
}

function runLatteAudit(data) {
    const container = document.getElementById('latte-list');
    const summary = document.getElementById('latte-total');
    if (!container) return;

    // 算法：金额 < 50, 频次 > 3
    const groups = _(data)
        .filter(d => d.amount > 0 && d.amount < 50)
        .groupBy(d => `${d.peer}-${d.category}`)
        .map((items, key) => ({
            name: items[0].peer,
            cat: items[0].category,
            count: items.length,
            total: _.sumBy(items, 'amount'),
            avg: _.sumBy(items, 'amount') / items.length
        }))
        .filter(g => g.count >= 3)
        .orderBy('total', 'desc')
        .value();

    if (groups.length === 0) {
        container.innerHTML = '<div class="empty-hint">暂未发现明显的拿铁因子。</div>';
        summary.innerText = '';
        return;
    }

    container.innerHTML = groups.map(g => `
        <div style="padding: 0.8rem; border-radius: 10px; background: rgba(168, 85, 247, 0.05); margin-bottom: 0.5rem; display: flex; justify-content: space-between; align-items: center;">
            <div>
                <div style="font-weight: 600; font-size: 0.85rem;">${g.name}</div>
                <div style="font-size: 0.75rem; color: var(--text-dim);">频次: ${g.count}次 | 均价: ¥${g.avg.toFixed(1)}</div>
            </div>
            <div style="color: #ef4444; font-weight: 700; font-family: 'Outfit';">¥${g.total.toFixed(0)}</div>
        </div>
    `).join('');

    const allTotal = _.sumBy(groups, 'total');
    summary.innerHTML = `<i data-lucide="alert-triangle" style="width:12px; height:12px; vertical-align:middle;"></i> 如果这部分消费能砍掉，一年可省下约 <b>¥${(allTotal * 12).toFixed(0)}</b>`;
    if (window.lucide) window.lucide.createIcons();
}

function runSubscriptionAudit(data) {
    const container = document.getElementById('sub-list');
    if (!container) return;

    // 算法：同商户、同金额、且日期差在 25-35 天之间
    const groups = _(data)
        .groupBy(d => `${d.peer}-${d.amount.toFixed(0)}`)
        .map((items, key) => {
            if (items.length < 2) return null;
            const sorted = _.sortBy(items, 'time');
            let isSub = false;
            for (let i = 1; i < sorted.length; i++) {
                const diffDays = (sorted[i].time - sorted[i - 1].time) / (1000 * 3600 * 24);
                if (diffDays >= 25 && diffDays <= 35) { isSub = true; break; }
            }
            return isSub ? { name: items[0].peer, amount: items[0].amount, items } : null;
        })
        .compact()
        .value();

    if (groups.length === 0) {
        container.innerHTML = '<div class="empty-hint">暂未识别出长期订阅。</div>';
        return;
    }

    container.innerHTML = groups.map(g => `
        <div style="padding: 0.8rem; border-radius: 10px; background: rgba(99, 102, 241, 0.05); margin-bottom: 0.5rem; display: flex; justify-content: space-between; align-items: center;">
            <div>
                <div style="font-weight: 600; font-size: 0.85rem;">${g.name}</div>
                <div style="font-size: 0.75rem; color: var(--text-dim);">疑似月度订阅服务</div>
            </div>
            <div style="color: var(--accent-primary); font-weight: 700; font-family: 'Outfit';">¥${g.amount.toFixed(1)}/月</div>
        </div>
    `).join('');
}

function renderTrendChart(data) {
    const el = document.getElementById('trend-chart');
    if (!el) return;
    const chart = echarts.init(el, currentTheme);
    const trend = _(data).groupBy('date_str').map((v, k) => ({ date: k, total: _.sumBy(v, 'amount') })).sortBy('date').value();

    // 使用对数变换压缩极值
    const logTrend = trend.map(t => ({ ...t, log: Math.log10(t.total + 1) }));

    chart.setOption({
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (params) => {
                const idx = params[0].dataIndex;
                return `<b>${trend[idx].date}</b><br/>支出: ¥${trend[idx].total.toFixed(2)}`;
            }
        },
        xAxis: { type: 'category', data: trend.map(x => x.date), axisLabel: { color: 'var(--text-dim)' } },
        yAxis: { type: 'value', splitLine: { show: false }, axisLabel: { show: false } },
        series: [{
            data: logTrend.map(x => x.log),
            type: 'line',
            smooth: true,
            areaStyle: { opacity: 0.15 },
            lineStyle: { width: 3, color: '#a855f7' },
            itemStyle: { color: '#a855f7' }
        }]
    });
    chart.on('click', p => showDrilldown(`日期流水: ${p.name}`, data.filter(d => d.date_str === p.name)));
}

function renderCategoryChart(data) {
    const el = document.getElementById('category-chart');
    if (!el) return;
    const chart = echarts.init(el, currentTheme);
    const cat = _(data).groupBy('category').map((v, k) => ({ name: k, value: _.sumBy(v, 'amount') })).orderBy('value', 'desc').value();
    chart.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'item', format: '{b}: ¥{c} ({d}%)', confine: true },
        series: [{ type: 'pie', radius: ['40%', '70%'], data: cat, label: { color: 'var(--text-main)', show: cat.length < 10 } }]
    });
    chart.on('click', p => showDrilldown(`分类详情: ${p.name}`, data.filter(d => d.category === p.name)));
}

function renderMerchantChart(data) {
    const el = document.getElementById('merchant-chart');
    if (!el) return;
    const chart = echarts.init(el, currentTheme);
    const merchants = _(data).groupBy('peer').map((v, k) => ({ name: k, value: _.sumBy(v, 'amount') })).orderBy('value', 'desc').take(10).reverse().value();
    chart.setOption({
        backgroundColor: 'transparent',
        tooltip: { confine: true },
        xAxis: { type: 'value', show: false },
        yAxis: { type: 'category', data: merchants.map(m => m.name), axisLabel: { color: 'var(--text-dim)', fontSize: 10 } },
        series: [{ data: merchants.map(m => m.value), type: 'bar', label: { show: true, position: 'right', color: 'var(--text-main)' }, itemStyle: { borderRadius: 4, color: '#6366f1' } }]
    });
    chart.on('click', p => showDrilldown(`商户往来: ${p.name}`, data.filter(d => d.peer === p.name)));
}

function renderSceneChart(data) {
    const el = document.getElementById('scene-pie');
    if (!el) return;
    const chart = echarts.init(el, currentTheme);
    const rules = [
        { label: '饮食外卖', keys: ['餐饮', '外卖', '美食', '饿了么', '美团', '瑞幸', '喜茶'] },
        { label: '交通出行', keys: ['滴滴', '打车', '地铁', '公交', '火车站', '加油', '停车'] },
        { label: '购物娱乐', keys: ['超市', '商场', '电影', '天猫', '京东', '拼多多', '直播'] }
    ];
    let groups = rules.map(r => ({ name: r.label, value: 0 }));
    let daily = 0;
    data.forEach(d => {
        let matched = false;
        rules.forEach((r, i) => { if (r.keys.some(k => d.peer.includes(k) || d.category.includes(k))) { groups[i].value += d.amount; matched = true; } });
        if (!matched) daily += d.amount;
    });
    groups.push({ name: '日常杂项', value: daily });
    chart.setOption({ backgroundColor: 'transparent', series: [{ type: 'pie', radius: ['35%', '60%'], data: groups.filter(g => g.value > 0), label: { color: 'var(--text-main)' } }] });
}

function renderTimeHeatmap(data) {
    const el = document.getElementById('time-heatmap');
    if (!el) return;

    // 聚合 24 小时数据：金额与频次
    const hoursData = new Array(24).fill(0).map((_, i) => ({ hour: i, total: 0, count: 0 }));
    data.forEach(d => {
        hoursData[d.hour].total += d.amount;
        hoursData[d.hour].count += 1;
    });

    // 使用对数变换压缩极值，让小额时段也能可见
    // log(x+1) 避免 log(0) 的问题
    const logValues = hoursData.map(d => Math.log10(d.total + 1));
    const maxLog = Math.max(...logValues);

    const chart = echarts.init(el, currentTheme);
    chart.setOption({
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'cross' },
            formatter: (params) => {
                const idx = params[0].dataIndex;
                const h = hoursData[idx].hour;
                const val = hoursData[idx].total;
                const count = hoursData[idx].count;
                return `<b>${h}:00 消费脉冲</b><br/>金额: ¥${val.toFixed(2)}<br/>频次: ${count} 次`;
            },
            confine: true
        },
        angleAxis: {
            type: 'category',
            data: hoursData.map(d => `${d.hour}h`),
            boundaryGap: false,
            splitLine: { show: true, lineStyle: { color: 'rgba(128,128,128,0.1)' } },
            axisLabel: { color: 'var(--text-dim)', fontSize: 10 }
        },
        radiusAxis: {
            type: 'value',
            max: maxLog || 1,
            show: false
        },
        polar: { radius: '80%' },
        series: [{
            type: 'bar',
            data: logValues,
            coordinateSystem: 'polar',
            name: '消费金额(对数)',
            itemStyle: {
                color: (params) => {
                    // 根据相对强度动态着色
                    const ratio = maxLog > 0 ? params.value / maxLog : 0;
                    const r = Math.round(168 + (244 - 168) * ratio);
                    const g = Math.round(85 + (63 - 85) * ratio);
                    const b = Math.round(247 + (94 - 247) * ratio);
                    return `rgb(${r}, ${g}, ${b})`;
                },
                borderRadius: 4
            },
            emphasis: {
                itemStyle: { color: '#f43f5e' }
            }
        }]
    });

    chart.on('click', p => {
        const h = parseInt(p.name);
        showDrilldown(`${h}点时段 消费行为审计`, data.filter(d => d.hour === h));
    });
}

function updateLoyaltyList(data) {
    const container = document.getElementById('loyalty-list');
    if (!container) return;
    const list = _(data).groupBy('peer').map((v, k) => ({ name: k, count: v.length, total: _.sumBy(v, 'amount') })).orderBy('count', 'desc').take(15).value();
    container.innerHTML = list.map(c => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.7rem; background: rgba(128,128,128,0.06); border-radius: 12px; margin-bottom: 0.6rem; border: 1px solid rgba(128,128,128,0.1);">
            <div style="font-size: 0.8rem; font-weight: 600;">${c.name} <small style="color: var(--text-dim); display: block; font-weight:400;">消费 ${c.count} 次</small></div>
            <div style="color: var(--accent-primary); font-family:'Outfit'; font-weight: 700;">¥${c.total.toFixed(0)}</div>
        </div>
    `).join('');
}

// --- 导入与配置 ---

async function handleFileUpload(files) {
    if (!files.length) return;

    try {
        let all = [];
        for (const f of files) {
            const data = await extractBills(f);
            all = [...all, ...data];
        }

        const res = await fetch(`${API_BASE}/bills`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(all)
        });

        if (!res.ok) throw new Error('后端响应异常');

        // 确保数据保存成功后再刷新
        await refreshData();

        showToast(`成功导入 ${all.length} 笔账单数据`, 'success');
    } catch (e) {
        showToast('导入失败，请检查文件格式或后端连接', 'error');
        console.error('Import Error:', e);
    }
}

async function extractBills(file) {
    const isCsv = file.name.toLowerCase().endsWith('.csv');
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, isCsv ? { type: 'array', codepage: 936 } : { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    const platform = JSON.stringify(raw).includes('微信') ? 'wechat' : 'alipay';

    const cfg = platform === 'wechat' ?
        { range: 16, map: { time: '交易时间', cat: '交易类型', peer: '交易对方', item: '商品', type: '收/支', amt: '金额(元)', id: '交易单号' } } :
        { range: 24, map: { time: '交易时间', cat: '交易分类', peer: '交易对方', item: '商品说明', type: '收/支', amt: '金额', id: '交易订单号' } };

    const rows = XLSX.utils.sheet_to_json(sheet, { range: cfg.range, raw: false });
    return rows.map(r => {
        const t = r[cfg.map.time]; if (!t) return null;

        // 手动处理中文 Excel 常见的 YYYY/MM/DD HH:mm:ss 格式
        // 将斜杠替换为连字符，使 dayjs 能够正确解析
        const normalized = String(t).replace(/\//g, '-');
        const d = dayjs(normalized);
        if (!d.isValid()) return null;

        const a = typeof r[cfg.map.amt] === 'number' ? r[cfg.map.amt] : parseFloat(String(r[cfg.map.amt]).replace(/[¥, ]/g, '')) || 0;
        return {
            id: (r[cfg.map.id] || Date.now() + Math.random()).toString(),
            platform, time: d.valueOf(), date_str: d.format('YYYY-MM-DD'), hour: d.hour(),
            category: r[cfg.map.cat] || '其它', peer: r[cfg.map.peer] || '未知', item: r[cfg.map.item] || '/',
            amount: a, type: r[cfg.map.type] || '支出', method: '手动导入'
        };
    }).filter(x => x && x.amount > 0 && (x.type === '支出' || x.type === '转账'));
}

async function loadConfig() {
    try {
        const res = await fetch(`${API_BASE}/config`);
        const cfg = await res.json();
        if (cfg) {
            const elMap = { 'input-api-key': 'api_key', 'input-base-url': 'base_url', 'input-ai-model': 'model_name', 'input-ai-prompt': 'custom_prompt', 'input-hourly-rate': 'hourly_rate' };
            Object.entries(elMap).forEach(([id, key]) => {
                const el = document.getElementById(id);
                if (el) el.value = cfg[key] || '';
            });
            hourlyRate = parseFloat(cfg.hourly_rate) || 0;
            if (cfg.api_key) {
                const aiBox = document.getElementById('ai-text');
                if (aiBox) aiBox.innerText = '🤖 您好！您的专属 AI 财务导师已待命。请选择分析模式并点击下方按钮，我将为您深度审计历史账单。';

                // 动态修改卡片标题，体现就绪状态
                const aiTitleIcon = document.querySelector('[data-lucide="brain-circuit"]');
                const aiTitle = aiTitleIcon?.parentElement;
                if (aiTitle) aiTitle.innerHTML = '<i data-lucide="brain-circuit"></i> AI 财务专家 (已就绪)';
                if (window.lucide) window.lucide.createIcons();
            }
        }
    } catch (e) { }
}

async function saveConfig() {
    const data = {
        api_key: document.getElementById('input-api-key')?.value,
        base_url: document.getElementById('input-base-url')?.value,
        model_name: document.getElementById('input-ai-model')?.value,
        custom_prompt: document.getElementById('input-ai-prompt')?.value,
        hourly_rate: document.getElementById('input-hourly-rate')?.value
    };
    await fetch(`${API_BASE}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    hourlyRate = parseFloat(data.hourly_rate) || 0;
    document.getElementById('config-modal').style.display = 'none';
    showToast('配置已保存', 'success');
    refreshData();
}

async function runAIAnalysis() {
    const box = document.getElementById('ai-text');
    if (box) box.innerText = '🤖 深度审计中...';
    try {
        const data = allTransactions.filter(t => t.status !== 'shadow');
        const res = await fetch(`${API_BASE}/ai/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: document.getElementById('role-selector')?.value, dataSummary: JSON.stringify(data.slice(0, 50)) })
        });
        const r = await res.json();
        box.innerHTML = `<div class="markdown-body">${marked.parse(r.content || r.error)}</div>`;
    } catch (e) { box.innerText = 'AI 出席失败，请检查配置。'; }
}

async function resetDatabase() { if (confirm('慎重：确定一键清空所有账单吗？')) { await fetch(`${API_BASE}/bills`, { method: 'DELETE' }); window.location.reload(); } }

function toggleTheme() {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem('theme', currentTheme);
    refreshData();
    if (window.lucide) window.lucide.createIcons();
}

window.addEventListener('resize', () => { document.querySelectorAll('[id$="chart"], [id$="pie"], [id$="heatmap"]').forEach(el => echarts.getInstanceByDom(el)?.resize()); });

// ===== V13: 标签系统功能 =====

// 一键应用规则
async function applyAutoTags() {
    const btn = document.getElementById('btn-auto-tag');
    if (!btn) return;

    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader" class="spin"></i> 应用中...';

    try {
        const res = await fetch(`${API_BASE}/tags/auto-apply`, { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            showToast(`成功为 ${data.processed} 笔交易自动打标签`, 'success');
            await refreshData();
            await loadTagStats();
        } else {
            showToast('应用失败', 'error');
        }
    } catch (e) {
        showToast('应用规则失败', 'error');
        console.error(e);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="zap"></i> 一键应用规则';
        if (window.lucide) window.lucide.createIcons();
    }
}

// 加载标签统计
async function loadTagStats() {
    try {
        const res = await fetch(`${API_BASE}/tags`);
        const tags = await res.json();
        renderTagStats(tags);
    } catch (e) {
        console.error('加载标签统计失败:', e);
    }
}

// 渲染标签统计
function renderTagStats(tags) {
    const container = document.getElementById('tag-stats-list');
    if (!container) return;

    if (tags.length === 0) {
        container.innerHTML = '<div class="empty-hint">点击"一键应用规则"自动为所有交易打标签</div>';
        return;
    }

    container.innerHTML = tags.map(tag => `
        <div class="tag-stat-item" data-tag-name="${tag.name}" style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0; border-bottom: 1px solid var(--border-color); cursor: pointer; transition: background 0.2s;">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
                <span class="tag" style="background: ${tag.color}; color: white;">${tag.name}</span>
                <span style="font-size: 0.75rem; color: var(--text-dim);">${tag.count} 笔</span>
            </div>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
                <span style="font-weight: 600; color: var(--accent-primary);">¥${tag.totalAmount.toFixed(2)}</span>
                <i data-lucide="chevron-right" style="width: 14px; height: 14px; color: var(--text-dim);"></i>
            </div>
        </div>
    `).join('');

    if (window.lucide) window.lucide.createIcons();

    // 绑定点击事件
    container.querySelectorAll('.tag-stat-item').forEach(item => {
        item.addEventListener('click', () => {
            const tagName = item.dataset.tagName;
            showTagDetails(tagName);
        });
        item.addEventListener('mouseenter', (e) => {
            e.currentTarget.style.background = 'rgba(168, 85, 247, 0.1)';
        });
        item.addEventListener('mouseleave', (e) => {
            e.currentTarget.style.background = 'transparent';
        });
    });
}

// 显示标签明细
function showTagDetails(tagName) {
    const modal = document.getElementById('drilldown-modal');
    const title = document.getElementById('drilldown-title');
    const container = document.getElementById('detail-list');

    if (!modal || !title || !container) return;

    // 隐藏常规筛选栏，标签下钻使用专用聚合视图
    const filterBar = modal.querySelector('.filter-bar');
    if (filterBar) filterBar.style.display = 'none';

    title.textContent = `标签专项复盘：${tagName}`;
    container.innerHTML = '<div style="text-align: center; padding: 2rem;">加载中...</div>';
    modal.style.display = 'flex';

    try {
        const transactions = allTransactions.filter(t => t.tags && t.tags.includes(tagName));

        if (transactions.length === 0) {
            container.innerHTML = '<div class="empty-hint">暂无关联交易</div>';
            return;
        }

        const total = transactions.reduce((sum, t) => sum + t.amount, 0);

        container.innerHTML = `
            <div style="margin-bottom: 1rem; padding: 1.2rem; background: rgba(168,85,247,0.1); border: 1px solid rgba(168,85,247,0.2); border-radius: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <span style="font-size: 0.85rem; color: var(--text-dim);">样本数量:</span>
                        <b style="color: var(--text-main); margin-left: 0.5rem; font-size: 1rem;">${transactions.length} 笔</b>
                    </div>
                    <div>
                        <span style="font-size: 0.85rem; color: var(--text-dim);">消耗总计:</span>
                        <b style="color: var(--accent-primary); font-size: 1.2rem; margin-left: 0.5rem; font-family: 'Outfit';">¥${total.toFixed(2)}</b>
                    </div>
                </div>
            </div>
            <div style="max-height: 450px; overflow-y: auto;">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>交易日期</th>
                            <th>商户场景</th>
                            <th style="text-align: right;">支出金额</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${transactions.map(t => `
                            <tr>
                                <td style="font-size: 0.75rem; vertical-align: middle;">${dayjs(t.time).format('MM-DD HH:mm')}</td>
                                <td style="vertical-align: middle;">
                                    <div style="font-weight: 600; line-height: 1.2;">${t.peer}</div>
                                    <div style="font-size: 0.7rem; color: var(--text-dim); margin-top: 2px;">${t.item || t.category}</div>
                                </td>
                                <td style="text-align: right; color: var(--accent-primary); font-weight: 700; font-family: 'Outfit'; vertical-align: middle;">
                                    ¥${t.amount.toFixed(2)}
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            <div style="margin-top: 1rem;">
                <button onclick="document.getElementById('drilldown-modal').style.display='none'" 
                        style="width: 100%; padding: 0.8rem; background: var(--bg-card); border: 1px solid var(--border-color); color: var(--text-main); border-radius: 10px; cursor: pointer; transition: 0.3s; font-weight: 600;">
                    返回看板首页
                </button>
            </div>
        `;
    } catch (e) {
        container.innerHTML = `<div class="empty-hint">加载失败: ${e.message}</div>`;
        console.error(e);
    }
}

start();
