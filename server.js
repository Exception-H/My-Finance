import express from 'express';
import Database from 'better-sqlite3';
import cors from 'cors';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const db = new Database('finance_data.db');
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// 初始化数据库
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    platform TEXT,
    time INTEGER,
    date_str TEXT,
    hour INTEGER,
    category TEXT,
    peer TEXT,
    item TEXT,
    amount REAL,
    type TEXT,
    method TEXT,
    status TEXT
  );
  
  CREATE TABLE IF NOT EXISTS ai_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    api_key TEXT,
    base_url TEXT
  );
`);

// 补丁逻辑：为旧表增加 model_name 和 custom_prompt 字段
try {
    db.prepare('ALTER TABLE ai_config ADD COLUMN model_name TEXT').run();
} catch (e) { /* 已存在 */ }
try {
    db.prepare('ALTER TABLE ai_config ADD COLUMN custom_prompt TEXT').run();
} catch (e) { /* 已存在 */ }
try {
    db.prepare('ALTER TABLE ai_config ADD COLUMN hourly_rate REAL').run();
} catch (e) { /* 已存在 */ }
try {
    db.prepare('ALTER TABLE transactions ADD COLUMN status TEXT').run();
} catch (e) { /* 已存在 */ }

// V13: 标签系统表
db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#a855f7',
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
  );
  
  CREATE TABLE IF NOT EXISTS transaction_tags (
    transaction_id TEXT,
    tag_id INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    PRIMARY KEY (transaction_id, tag_id),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  );
`);

// API: 获取所有账单（V13: 包含标签）
app.get('/api/bills', (req, res) => {
    const rows = db.prepare(`
        SELECT 
            t.*,
            GROUP_CONCAT(tags.name) as tags
        FROM transactions t
        LEFT JOIN transaction_tags tt ON t.id = tt.transaction_id
        LEFT JOIN tags ON tt.tag_id = tags.id
        GROUP BY t.id
        ORDER BY t.time DESC
    `).all();

    // 将标签字符串转为数组
    rows.forEach(row => {
        row.tags = row.tags ? row.tags.split(',') : [];
    });

    res.json(rows);
});

// API: 批量保存账单 (V7 增加影子流水识别)
app.post('/api/bills', (req, res) => {
    try {
        const bills = req.body;
        const insert = db.prepare(`
            INSERT OR REPLACE INTO transactions (id, platform, time, date_str, hour, category, peer, item, amount, type, method, status)
            VALUES (@id, @platform, @time, @date_str, @hour, @category, @peer, @item, @amount, @type, @method, @status)
        `);

        // 使用数据库事务极大提升 1000+ 数据量的写入速度
        const insertMany = db.transaction((data) => {
            for (const bill of data) {
                const isInternal = /转账|还款|提现|充值/.test(bill.type) ||
                    /余额宝|零钱通|理财|余利宝|理财通/.test(bill.peer) ||
                    /信用卡/.test(bill.peer);

                if (isInternal) {
                    bill.status = 'shadow';
                } else {
                    bill.status = bill.status || '成功';
                }
                insert.run(bill);
            }
        });

        insertMany(bills);
        res.json({ success: true, count: bills.length });
    } catch (e) {
        console.error('Import API Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// API: 清空所有账单
app.delete('/api/bills', (req, res) => {
    db.prepare('DELETE FROM transactions').run();
    res.json({ success: true });
});

// API: AI 分析接口
app.post('/api/ai/analyze', async (req, res) => {
    const { role, dataSummary } = req.body;
    const config = db.prepare('SELECT * FROM ai_config WHERE id = 1').get();

    if (!config || !config.api_key) {
        return res.status(400).json({ error: '请先点击右上角“配置”设置 API Key' });
    }

    const openai = new OpenAI({
        apiKey: config.api_key,
        baseURL: config.base_url || 'https://api.openai.com/v1'
    });

    const roles = {
        'critic': '你是一个毒舌且刻薄的理财师。你的目标是无情嘲讽用户的消费习惯。请直接输出 Markdown 格式的报告。要求：1.直接开始分析，不要说“好的”、“收到”等废话；2.大量使用 Markdown 的标题、列表和加粗；3.语气要尖酸刻薄但道理客观。',
        'assistant': '你是一个贴心且温柔的私人财务助理。请直接输出 Markdown 格式的报告。要求：1.直接进入正题，不要客套；2.使用 Markdown 展现分点建议；3.语气温婉，像家人一样给出关怀。',
        'scientist': '你是一个硬核的数据分析专家。请直接输出 Markdown 格式的报告。要求：1.输出一份标准的财务审计周报；2.包含统计学模型描述、偏差分析和趋势预测；3.使用 Markdown 列表和表格（如果适用）；4.不含有任何冗余的礼貌性回复。'
    };

    const systemPrompt = config.custom_prompt || roles[role] || roles['scientist'];

    try {
        const response = await openai.chat.completions.create({
            model: config.model_name || "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `这是我的消费数据摘要：\n${dataSummary}\n请根据你的角色定位给出深入的分析结论。` }
            ]
        });
        res.json({ content: response.choices[0].message.content });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: 智能对话接口 (V12: Function Calling)
app.post('/api/ai/chat', async (req, res) => {
    const { message, history } = req.body;
    const config = db.prepare('SELECT * FROM ai_config WHERE id = 1').get();

    if (!config?.api_key) return res.status(400).json({ error: '请先配置 API Key' });

    const openai = new OpenAI({ apiKey: config.api_key, baseURL: config.base_url || 'https://api.openai.com/v1' });

    // 定义工具 Schema
    const tools = [
        {
            type: "function",
            function: {
                name: "queryTransactions",
                description: "查询符合条件的账单数据。支持模糊搜索商户名和商品名。",
                parameters: {
                    type: "object",
                    properties: {
                        merchant: { type: "string", description: "商户名称（模糊搜索），例如：'瑞幸' 可以匹配 '瑞幸咖啡'" },
                        category: { type: "string", description: "消费分类，例如：'餐饮'、'交通'" },
                        minAmount: { type: "number", description: "最小金额（单位：元），例如：100" },
                        maxAmount: { type: "number", description: "最大金额（单位：元），例如：500" },
                        startDate: { type: "string", description: "开始日期（格式：YYYY-MM-DD），例如：'2024-11-01'" },
                        endDate: { type: "string", description: "结束日期（格式：YYYY-MM-DD），例如：'2024-11-30'" },
                        limit: { type: "number", description: "返回条数限制，默认 50" }
                    }
                }
            }
        },
        {
            type: "function",
            function: {
                name: "getStatistics",
                description: "获取指定时期的统计数据摘要",
                parameters: {
                    type: "object",
                    properties: {
                        period: { type: "string", enum: ["week", "month", "year", "all"], description: "统计时期" },
                        groupBy: { type: "string", enum: ["category", "merchant", "date"], description: "分组维度" }
                    },
                    required: ["period"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "getTopMerchants",
                description: "获取消费频次或金额最高的商户排行",
                parameters: {
                    type: "object",
                    properties: {
                        limit: { type: "number", description: "返回前 N 名，默认 10" },
                        sortBy: { type: "string", enum: ["amount", "frequency"], description: "排序依据" }
                    }
                }
            }
        },
        {
            type: "function",
            function: {
                name: "analyzeLatteFactors",
                description: "识别小额高频消费（拿铁因子），返回隐形开支列表"
            }
        },
        {
            type: "function",
            function: {
                name: "detectSubscriptions",
                description: "自动识别周期性订阅服务"
            }
        },
        {
            type: "function",
            function: {
                name: "comparePeriods",
                description: "对比两个时间段的消费差异",
                parameters: {
                    type: "object",
                    properties: {
                        period1Start: { type: "string", description: "时期1开始日期，格式：YYYY-MM-DD" },
                        period1End: { type: "string", description: "时期1结束日期，格式：YYYY-MM-DD" },
                        period2Start: { type: "string", description: "时期2开始日期，格式：YYYY-MM-DD" },
                        period2End: { type: "string", description: "时期2结束日期，格式：YYYY-MM-DD" }
                    },
                    required: ["period1Start", "period1End", "period2Start", "period2End"]
                }
            }
        }
    ];

    // 工具执行函数
    function executeTool(name, args) {
        try {
            switch (name) {
                case 'queryTransactions': {
                    let sql = "SELECT * FROM transactions WHERE (status IS NULL OR status != 'shadow')";
                    const params = [];

                    if (args.merchant) {
                        sql += " AND peer LIKE ?";
                        params.push(`%${args.merchant}%`);
                    }
                    if (args.category) {
                        sql += " AND category = ?";
                        params.push(args.category);
                    }
                    if (args.minAmount) {
                        sql += " AND amount >= ?";
                        params.push(args.minAmount);
                    }
                    if (args.maxAmount) {
                        sql += " AND amount <= ?";
                        params.push(args.maxAmount);
                    }
                    if (args.startDate) {
                        const ts = new Date(args.startDate).getTime();
                        sql += " AND time >= ?";
                        params.push(ts);
                    }
                    if (args.endDate) {
                        const ts = new Date(args.endDate).getTime() + 86400000;
                        sql += " AND time < ?";
                        params.push(ts);
                    }

                    sql += " ORDER BY time DESC LIMIT ?";
                    params.push(args.limit || 50);

                    return db.prepare(sql).all(...params);
                }

                case 'getStatistics': {
                    const periodMap = { week: 7, month: 30, year: 365 };
                    let sql = "SELECT ";

                    if (args.groupBy === 'category') {
                        sql += "category, SUM(amount) as total, COUNT(*) as count";
                    } else if (args.groupBy === 'merchant') {
                        sql += "peer as merchant, SUM(amount) as total, COUNT(*) as count";
                    } else {
                        sql += "date_str as date, SUM(amount) as total, COUNT(*) as count";
                    }

                    sql += " FROM transactions WHERE (status IS NULL OR status != 'shadow')";

                    if (args.period !== 'all') {
                        const days = periodMap[args.period];
                        const cutoff = Date.now() - days * 24 * 3600 * 1000;
                        sql += ` AND time > ${cutoff}`;
                    }

                    sql += ` GROUP BY ${args.groupBy === 'merchant' ? 'peer' : args.groupBy} ORDER BY total DESC`;

                    return db.prepare(sql).all();
                }

                case 'getTopMerchants': {
                    const orderBy = args.sortBy === 'frequency' ? 'count DESC' : 'total DESC';
                    const sql = `SELECT peer as merchant, SUM(amount) as total, COUNT(*) as count 
                                 FROM transactions WHERE (status IS NULL OR status != 'shadow') 
                                 GROUP BY peer ORDER BY ${orderBy} LIMIT ?`;
                    return db.prepare(sql).all(args.limit || 10);
                }

                case 'analyzeLatteFactors': {
                    const sql = `SELECT peer, item, AVG(amount) as avg_amount, COUNT(*) as frequency, SUM(amount) as total
                                 FROM transactions 
                                 WHERE amount < 50 AND (status IS NULL OR status != 'shadow')
                                 GROUP BY peer HAVING frequency >= 3 ORDER BY total DESC LIMIT 10`;
                    return db.prepare(sql).all();
                }

                case 'detectSubscriptions': {
                    const sql = `SELECT peer, amount, COUNT(*) as frequency, GROUP_CONCAT(time) as timestamps
                                 FROM transactions WHERE (status IS NULL OR status != 'shadow')
                                 GROUP BY peer, amount HAVING frequency >= 2 ORDER BY frequency DESC LIMIT 10`;
                    return db.prepare(sql).all();
                }

                case 'comparePeriods': {
                    const p1Start = new Date(args.period1Start).getTime();
                    const p1End = new Date(args.period1End).getTime() + 86400000;
                    const p2Start = new Date(args.period2Start).getTime();
                    const p2End = new Date(args.period2End).getTime() + 86400000;

                    const sql1 = `SELECT SUM(amount) as total, COUNT(*) as count FROM transactions 
                                  WHERE time >= ? AND time < ? AND (status IS NULL OR status != 'shadow')`;
                    const sql2 = `SELECT category, SUM(amount) as total FROM transactions 
                                  WHERE time >= ? AND time < ? AND (status IS NULL OR status != 'shadow') GROUP BY category`;

                    const p1Summary = db.prepare(sql1).get(p1Start, p1End);
                    const p2Summary = db.prepare(sql1).get(p2Start, p2End);
                    const p1ByCategory = db.prepare(sql2).all(p1Start, p1End);
                    const p2ByCategory = db.prepare(sql2).all(p2Start, p2End);

                    return {
                        period1: { ...p1Summary, byCategory: p1ByCategory },
                        period2: { ...p2Summary, byCategory: p2ByCategory }
                    };
                }

                default:
                    return { error: `Unknown tool: ${name}` };
            }
        } catch (e) {
            console.error(`Tool execution error (${name}):`, e);
            return { error: e.message };
        }
    }

    try {
        const messages = [
            { role: "system", content: config.custom_prompt || "你是一个专业的财务导师。用户会询问关于账单数据的问题，你可以调用工具查询数据，然后基于真实数据给出分析和建议。" },
            ...history,
            { role: "user", content: message }
        ];

        let response = await openai.chat.completions.create({
            model: config.model_name || "gpt-4o-mini",
            messages,
            tools,
            tool_choice: "auto"
        });

        let assistantMessage = response.choices[0].message;

        // 工具调用循环
        while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
            messages.push(assistantMessage);

            for (const toolCall of assistantMessage.tool_calls) {
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);

                console.log(`[Tool Call] ${functionName}:`, functionArgs);
                const functionResult = executeTool(functionName, functionArgs);

                // 如果工具执行返回错误，记录但不中断连接
                if (functionResult && functionResult.error) {
                    console.error(`[Tool Error] ${functionName}:`, functionResult.error);
                }

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: functionName,
                    content: JSON.stringify(functionResult)
                });
            }

            response = await openai.chat.completions.create({
                model: config.model_name || "gpt-4o-mini",
                messages
            });

            assistantMessage = response.choices[0].message;
        }

        res.json({ content: assistantMessage.content });
    } catch (e) {
        console.error('AI Chat Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// API: 设置配置 (增加时薪)
app.post('/api/config', (req, res) => {
    const { api_key, base_url, model_name, custom_prompt, hourly_rate } = req.body;
    db.prepare('INSERT OR REPLACE INTO ai_config (id, api_key, base_url, model_name, custom_prompt, hourly_rate) VALUES (1, ?, ?, ?, ?, ?)').run(api_key, base_url, model_name, custom_prompt, hourly_rate);
    res.json({ success: true });
});

app.get('/api/config', (req, res) => {
    const config = db.prepare('SELECT api_key, base_url, model_name, custom_prompt, hourly_rate FROM ai_config WHERE id = 1').get();
    res.json(config || {});
});

// ===== V13: 标签系统 API =====

// 规则引擎：自动为交易打标签
function autoTagTransaction(transaction) {
    const tags = [];
    const hour = new Date(transaction.time).getHours();
    const day = new Date(transaction.time).getDay();
    const merchant = transaction.peer || '';
    const amount = transaction.amount;

    // 金额规则
    if (amount < 50) tags.push('小额');
    if (amount >= 500) tags.push('重要决策');

    // 时间规则
    if (hour >= 22 || hour <= 6) tags.push('深夜消费');
    if (day === 0 || day === 6) tags.push('周末');

    // 商户关键词规则
    if (/咖啡|奶茶|茶饮|饮品/.test(merchant)) tags.push('习惯性');
    if (/健身|瑜伽|游泳|跑步|运动/.test(merchant)) tags.push('健康');
    if (/书店|课程|培训|教育|学习/.test(merchant)) tags.push('投资自己');
    if (/餐厅|聚餐|火锅|烧烤|KTV|电影|酒吧/.test(merchant)) tags.push('社交');
    if (/超市|菜市场|生鲜/.test(merchant)) tags.push('必要');

    return [...new Set(tags)]; // 去重
}

// 获取或创建标签
function getOrCreateTag(tagName) {
    let tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
    if (!tag) {
        const result = db.prepare('INSERT INTO tags (name) VALUES (?)').run(tagName);
        tag = { id: result.lastInsertRowid };
    }
    return tag.id;
}

// API: 获取所有标签及统计
app.get('/api/tags', (req, res) => {
    const tags = db.prepare(`
        SELECT 
            t.id,
            t.name,
            t.color,
            COUNT(tt.transaction_id) as count,
            COALESCE(SUM(tr.amount), 0) as totalAmount
        FROM tags t
        LEFT JOIN transaction_tags tt ON t.id = tt.tag_id
        LEFT JOIN transactions tr ON tt.transaction_id = tr.id AND (tr.status IS NULL OR tr.status != 'shadow')
        GROUP BY t.id
        ORDER BY totalAmount DESC
    `).all();
    res.json(tags);
});

// API: 为交易打标签
app.post('/api/bills/:id/tags', (req, res) => {
    const { id } = req.params;
    const { tagNames } = req.body;

    try {
        const stmt = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)');
        const addTags = db.transaction((transactionId, names) => {
            for (const tagName of names) {
                const tagId = getOrCreateTag(tagName);
                stmt.run(transactionId, tagId);
            }
        });

        addTags(id, tagNames);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: 删除交易的某个标签
app.delete('/api/bills/:id/tags/:tagName', (req, res) => {
    const { id, tagName } = req.params;

    try {
        const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
        if (tag) {
            db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ? AND tag_id = ?').run(id, tag.id);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: 按商户批量打标签
app.post('/api/tags/batch/merchant', (req, res) => {
    const { merchantName, tagNames } = req.body;

    try {
        const transactions = db.prepare('SELECT id FROM transactions WHERE peer = ? AND (status IS NULL OR status != \'shadow\')').all(merchantName);

        const stmt = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)');
        const batchAdd = db.transaction((txs, names) => {
            for (const tagName of names) {
                const tagId = getOrCreateTag(tagName);
                for (const tx of txs) {
                    stmt.run(tx.id, tagId);
                }
            }
        });

        batchAdd(transactions, tagNames);
        res.json({ success: true, affected: transactions.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: 批量应用规则引擎
app.post('/api/tags/auto-apply', (req, res) => {
    try {
        const transactions = db.prepare('SELECT * FROM transactions WHERE (status IS NULL OR status != \'shadow\')').all();

        const stmt = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)');
        const autoApply = db.transaction((txs) => {
            for (const tx of txs) {
                const suggestedTags = autoTagTransaction(tx);
                for (const tagName of suggestedTags) {
                    const tagId = getOrCreateTag(tagName);
                    stmt.run(tx.id, tagId);
                }
            }
        });

        autoApply(transactions);
        res.json({ success: true, processed: transactions.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(3000, () => console.log('Backend running on http://localhost:3000'));
