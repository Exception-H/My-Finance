const XLSX = require('xlsx');

const PARSE_CONFIG = {
    wechat: {
        headerRow: 17,
        mapping: {
            time: '交易时间',
            category: '交易类型', // 微信默认没有精细分类，后续可通过 AI 或关键词增强
            peer: '交易对方',
            item: '商品',
            type: '收/支',
            amount: '金额(元)',
            method: '支付方式',
            status: '当前状态'
        }
    },
    alipay: {
        headerRow: 25,
        mapping: {
            time: '交易时间',
            category: '交易分类',
            peer: '交易对方',
            item: '商品说明',
            type: '收/支',
            amount: '金额',
            method: '收/付款方式',
            status: '交易状态'
        }
    }
};

/**
 * 格式化数值：去除符号，确保为数字
 */
function parseAmount(val) {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
        const cleanStr = val.replace(/[¥, ]/g, '');
        return parseFloat(cleanStr) || 0;
    }
    return 0;
}

/**
 * 格式化 Excel 日期
 */
function parseDate(val) {
    if (val instanceof Date) return val;
    if (typeof val === 'number') {
        // Excel 序列日期 (1900-01-01 为起点)
        return new Date(Math.round((val - 25569) * 86400 * 1000));
    }
    if (typeof val === 'string') {
        return new Date(val);
    }
    return new Date();
}

function processExcel(filename, platform) {
    const config = PARSE_CONFIG[platform];
    const workbook = XLSX.readFile(filename);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    // headerRow 是 1-indexed，range 是 0-indexed
    const data = XLSX.utils.sheet_to_json(sheet, { range: config.headerRow - 1 });

    return data.map(row => {
        const unifiedRow = {
            platform: platform,
            raw_time: row[config.mapping.time],
            time_obj: parseDate(row[config.mapping.time]),
            category: row[config.mapping.category] || '未分类',
            peer: row[config.mapping.peer],
            item: row[config.mapping.item],
            type: row[config.mapping.type],
            amount: parseAmount(row[config.mapping.amount]),
            method: row[config.mapping.method],
            status: row[config.mapping.status]
        };

        // 生成派生字段
        const date = unifiedRow.time_obj;
        unifiedRow.date_str = date.toISOString().split('T')[0];
        unifiedRow.hour = date.getHours();
        unifiedRow.month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

        return unifiedRow;
    }).filter(row => row.amount > 0 && row.status !== '已退款');
}

module.exports = { processExcel };
