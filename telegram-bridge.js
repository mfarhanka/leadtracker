const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const port = Number(process.env.LEADTRACKER_TG_PORT || 3031);
const token = process.env.TELEGRAM_BOT_TOKEN || '';
const appUrl = process.env.LEADTRACKER_APP_URL || 'http://127.0.0.1/leadtracker/index.php';
const whatsappBridgePort = Number(process.env.LEADTRACKER_WA_PORT || 3030);
const dataDir = path.join(__dirname, 'data');
const leadsFile = path.join(dataDir, 'leads.json');
const templatesFile = path.join(dataDir, 'templates.json');

let offset = 0;
let status = token ? 'starting' : 'missing_token';
let statusMessage = token
    ? 'Starting Telegram bridge...'
    : 'Set TELEGRAM_BOT_TOKEN, then restart start-telegram-bridge.bat.';
let botName = '';
let lastError = '';
let processedCount = 0;
const sessions = new Map();

function requestJson(method, params = {}) {
    return new Promise((resolve, reject) => {
        if (!token) {
            reject(new Error('TELEGRAM_BOT_TOKEN is required.'));
            return;
        }

        const body = JSON.stringify(params);
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${token}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 35000,
        }, (res) => {
            let response = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                response += chunk;
            });
            res.on('end', () => {
                try {
                    const payload = JSON.parse(response);
                    if (!payload.ok) {
                        reject(new Error(payload.description || `Telegram API error ${res.statusCode}`));
                        return;
                    }
                    resolve(payload.result);
                } catch (error) {
                    reject(new Error('Invalid Telegram API response.'));
                }
            });
        });

        req.on('timeout', () => req.destroy(new Error('Telegram API request timed out.')));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
            return fallback;
        }
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : fallback;
    } catch (error) {
        return fallback;
    }
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 4), 'utf8');
}

function normalizePhone(value) {
    let digits = String(value || '').replace(/\D+/g, '');
    if (digits.startsWith('00')) {
        digits = digits.slice(2);
    }
    if (digits.startsWith('0')) {
        digits = `6${digits}`;
    }
    if (digits.startsWith('1')) {
        digits = `60${digits}`;
    }
    return digits;
}

function cleanUrl(value) {
    let url = String(value || '').trim();
    if (!url) {
        return '';
    }
    if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
    }
    try {
        return new URL(url).toString();
    } catch (error) {
        return '';
    }
}

function defaultMessageTemplate() {
    return [
        'Hi {company}, saya berminat nak tanya tentang kerja yang diiklankan.',
        '',
        'Saya jumpa iklan ini: {ad_link}',
        '---',
        'Boleh saya tahu masih ada kekosongan dan bagaimana cara untuk apply?',
        'Terima kasih.',
    ].join('\n');
}

function getDefaultTemplate() {
    const templates = readJson(templatesFile, []);
    const first = templates.find((template) => String(template.body || '').trim() !== '');
    return {
        id: String(first?.id || ''),
        name: String(first?.name || 'Default'),
        body: String(first?.body || defaultMessageTemplate()),
        delaySeconds: Number.parseInt(first?.delay_seconds || '10', 10) || 10,
    };
}

function normalizeTemplateDelaySeconds(value) {
    const delay = Number.parseInt(value, 10);
    if (!Number.isFinite(delay)) {
        return 10;
    }
    return Math.min(Math.max(delay, 0), 30);
}

function loadTemplateOptions() {
    const templates = readJson(templatesFile, [])
        .filter((template) => String(template.body || '').trim() !== '')
        .map((template) => ({
            id: String(template.id || ''),
            name: String(template.name || 'Untitled Template'),
            body: String(template.body || ''),
            delaySeconds: normalizeTemplateDelaySeconds(template.delay_seconds || 10),
        }));

    if (templates.length > 0) {
        return templates;
    }

    return [getDefaultTemplate()];
}

function loadTemplates() {
    return readJson(templatesFile, []);
}

function saveTemplates(templates) {
    writeJson(templatesFile, templates);
}

function findTemplate(templates, templateId) {
    return templates.find((template) => String(template.id || '') === templateId) || null;
}

function templateSummary(template) {
    const name = String(template.name || 'Untitled Template');
    const body = String(template.body || '');
    const delaySeconds = normalizeTemplateDelaySeconds(template.delay_seconds || 10);
    const preview = body.length > 700 ? `${body.slice(0, 700)}...` : body;
    return [
        `Template: ${name}`,
        `Delay: ${delaySeconds}s`,
        '',
        preview || '(empty)',
    ].join('\n');
}

function makeTemplateKeyboard(templates) {
    const rows = templates.slice(0, 48).map((template, index) => ([{
        text: template.name.slice(0, 60),
        callback_data: `tpl:${index}`,
    }]));

    rows.push([{ text: 'Use default template', callback_data: 'tpl:default' }]);
    return rows;
}

function makeTemplateManagerKeyboard(templates) {
    const rows = [[{ text: 'Add Template', callback_data: 'tm:add' }]];
    for (const template of templates.slice(0, 48)) {
        rows.push([{ text: String(template.name || 'Untitled Template').slice(0, 60), callback_data: `tm:view:${template.id}` }]);
    }
    return rows;
}

function makeTemplateDetailKeyboard(templateId) {
    return [
        [
            { text: 'Edit Name', callback_data: `tm:edit:name:${templateId}` },
            { text: 'Edit Delay', callback_data: `tm:edit:delay:${templateId}` },
        ],
        [{ text: 'Edit Message', callback_data: `tm:edit:body:${templateId}` }],
        [
            { text: 'Delete', callback_data: `tm:del:${templateId}` },
            { text: 'Back', callback_data: 'tm:list' },
        ],
    ];
}

function makeTemplateDoneKeyboard() {
    return [
        [
            { text: '/new', callback_data: 'lead:new' },
            { text: 'New Template', callback_data: 'tm:add' },
        ],
        [{ text: 'Templates', callback_data: 'tm:list' }],
    ];
}

function makeLeadDoneKeyboard(lead) {
    return [
        [
            { text: 'Send WhatsApp', callback_data: `sendwa:${lead.id}` },
            { text: 'Mark Sent', callback_data: `sent:${lead.id}` },
        ],
        [
            { text: '/new', callback_data: 'lead:new' },
            { text: 'Templates', callback_data: 'tm:list' },
        ],
        [
            { text: 'Open WhatsApp', url: buildWhatsappUrl(lead) },
            { text: 'Open LeadTracker', url: appUrl },
        ],
    ];
}

function makeQuickDoneKeyboard() {
    return [[
        { text: '/new', callback_data: 'lead:new' },
        { text: 'Templates', callback_data: 'tm:list' },
    ]];
}

function renderMessage(template, lead) {
    const message = String(template || defaultMessageTemplate()).replace(/\{company\}|\{ad_link\}|\{phone\}|\{source\}/g, (match) => {
        if (match === '{company}') return lead.company || '';
        if (match === '{ad_link}') return lead.ad_link || '';
        if (match === '{phone}') return lead.phone || '';
        if (match === '{source}') return lead.source || '';
        return match;
    });

    return message
        .split(/\r?\n/)
        .filter((line) => line.trim() !== 'Saya jumpa iklan ini:' || lead.ad_link)
        .join('\n');
}

function splitMessageParts(message) {
    return String(message || '')
        .split(/^\s*---\s*$/m)
        .map((part) => part.trim())
        .filter(Boolean);
}

function parseLeadFromMessage(message) {
    const text = String(message.text || message.caption || '').trim();
    const contactPhone = message.contact?.phone_number || '';
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const fields = {};
    const looseLines = [];

    for (const line of lines) {
        const match = line.match(/^(name|company|contact|phone|whatsapp|link|url)\s*[:=-]\s*(.+)$/i);
        if (!match) {
            looseLines.push(line);
            continue;
        }
        const key = match[1].toLowerCase();
        const value = match[2].trim();
        if (key === 'name' || key === 'company') fields.name = value;
        if (key === 'contact' || key === 'phone' || key === 'whatsapp') fields.phone = value;
        if (key === 'link' || key === 'url') fields.link = value;
    }

    const urlMatch = text.match(/https?:\/\/[^\s<>"']+|(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>"']*)?/i);
    const phoneMatch = text.match(/(?:\+?6?0|0)?1[0-9][\s.-]*[0-9]{3,4}[\s.-]*[0-9]{4}/);
    const adLink = cleanUrl(fields.link || (urlMatch ? urlMatch[0] : ''));
    const phone = normalizePhone(fields.phone || contactPhone || (phoneMatch ? phoneMatch[0] : ''));

    let company = String(fields.name || '').trim();
    if (!company) {
        company = looseLines.find((line) => {
            if (urlMatch && line.includes(urlMatch[0])) return false;
            if (phoneMatch && line.includes(phoneMatch[0])) return false;
            return !/^(hi|hello|salam|start)$/i.test(line);
        }) || '';
    }

    return {
        company: company.trim(),
        phone,
        adLink,
        rawText: text,
    };
}

function getChatText(message) {
    return String(message.text || message.caption || '').trim();
}

function getChatPhone(message) {
    return normalizePhone(message.contact?.phone_number || getChatText(message));
}

function createSession(chatId) {
    const session = {
        mode: 'lead',
        step: 'phone',
        phone: '',
        adLink: '',
        company: '',
        templates: [],
    };
    sessions.set(String(chatId), session);
    return session;
}

function getSession(chatId) {
    return sessions.get(String(chatId));
}

function clearSession(chatId) {
    sessions.delete(String(chatId));
}

async function askPhone(chatId) {
    createSession(chatId);
    await requestJson('sendMessage', {
        chat_id: chatId,
        text: 'Send WhatsApp phone number.',
    });
}

async function startLeadFlow(chatId) {
    await requestJson('sendMessage', {
        chat_id: chatId,
        text: [
            'I will ask for lead details one by one.',
            '',
            '1. Phone number',
            '2. Ads link, optional',
            '3. Name, optional',
            '4. Message template',
            '',
            'Use /templates to add, edit, or delete templates.',
            'Use /cancel to stop the current flow.',
        ].join('\n'),
    });
    await askPhone(chatId);
}

async function askAdLink(chatId) {
    await requestJson('sendMessage', {
        chat_id: chatId,
        text: 'Send ads link.',
        reply_markup: {
            inline_keyboard: [[
                { text: 'Skip ads link', callback_data: 'skip:adLink' },
            ]],
        },
    });
}

async function askName(chatId) {
    await requestJson('sendMessage', {
        chat_id: chatId,
        text: 'Send name.',
        reply_markup: {
            inline_keyboard: [[
                { text: 'Skip name', callback_data: 'skip:company' },
            ]],
        },
    });
}

async function askTemplate(chatId, session) {
    session.step = 'template';
    session.templates = loadTemplateOptions();
    await requestJson('sendMessage', {
        chat_id: chatId,
        text: 'Select message template.',
        reply_markup: {
            inline_keyboard: makeTemplateKeyboard(session.templates),
        },
    });
}

async function showTemplateManager(chatId) {
    const templates = loadTemplates();
    await requestJson('sendMessage', {
        chat_id: chatId,
        text: templates.length > 0 ? 'Select a template to manage.' : 'No templates yet. Add one from Telegram.',
        reply_markup: {
            inline_keyboard: makeTemplateManagerKeyboard(templates),
        },
    });
}

async function showTemplateDetail(chatId, templateId) {
    const template = findTemplate(loadTemplates(), templateId);
    if (!template) {
        await requestJson('sendMessage', {
            chat_id: chatId,
            text: 'Template was not found.',
        });
        return;
    }

    await requestJson('sendMessage', {
        chat_id: chatId,
        text: templateSummary(template),
        reply_markup: {
            inline_keyboard: makeTemplateDetailKeyboard(templateId),
        },
    });
}

async function startTemplateAdd(chatId) {
    sessions.set(String(chatId), {
        mode: 'template_add',
        step: 'name',
        draft: {
            name: '',
            body: '',
            delaySeconds: 10,
        },
    });
    await requestJson('sendMessage', {
        chat_id: chatId,
        text: 'Send template name.',
    });
}

async function startTemplateEdit(chatId, templateId, field) {
    const template = findTemplate(loadTemplates(), templateId);
    if (!template) {
        await requestJson('sendMessage', {
            chat_id: chatId,
            text: 'Template was not found.',
        });
        return;
    }

    sessions.set(String(chatId), {
        mode: 'template_edit',
        step: field,
        templateId,
    });

    const prompt = field === 'body'
        ? 'Send new template message. Use --- on its own line to split WhatsApp messages.'
        : field === 'delay'
            ? 'Send seconds between messages, 0 to 30.'
            : 'Send new template name.';

    await requestJson('sendMessage', {
        chat_id: chatId,
        text: prompt,
    });
}

async function handleTemplateSessionMessage(message, session) {
    const chatId = message.chat.id;
    const text = getChatText(message);

    if (session.mode === 'template_add') {
        if (session.step === 'name') {
            if (!text) {
                await requestJson('sendMessage', { chat_id: chatId, text: 'Template name is required.' });
                return;
            }
            session.draft.name = text;
            session.step = 'body';
            await requestJson('sendMessage', {
                chat_id: chatId,
                text: 'Send template message. Use --- on its own line to split WhatsApp messages.',
            });
            return;
        }

        if (session.step === 'body') {
            if (!text) {
                await requestJson('sendMessage', { chat_id: chatId, text: 'Template message is required.' });
                return;
            }
            session.draft.body = text;
            session.step = 'delay';
            await requestJson('sendMessage', {
                chat_id: chatId,
                text: 'Send seconds between messages, 0 to 30. Send 10 if unsure.',
            });
            return;
        }

        if (session.step === 'delay') {
            const now = new Date().toISOString();
            const template = {
                id: crypto.randomBytes(8).toString('hex'),
                name: session.draft.name,
                body: session.draft.body,
                delay_seconds: normalizeTemplateDelaySeconds(text),
                created_at: now,
                updated_at: now,
            };
            const templates = loadTemplates();
            templates.push(template);
            saveTemplates(templates);
            clearSession(chatId);
            await requestJson('sendMessage', {
                chat_id: chatId,
                text: `Template saved: ${template.name}`,
                reply_markup: {
                    inline_keyboard: makeTemplateDoneKeyboard(),
                },
            });
            await showTemplateDetail(chatId, template.id);
            return;
        }
    }

    if (session.mode === 'template_edit') {
        const templates = loadTemplates();
        const template = findTemplate(templates, session.templateId);
        if (!template) {
            clearSession(chatId);
            await requestJson('sendMessage', { chat_id: chatId, text: 'Template was not found.' });
            return;
        }

        if (session.step === 'name') {
            if (!text) {
                await requestJson('sendMessage', { chat_id: chatId, text: 'Template name is required.' });
                return;
            }
            template.name = text;
        } else if (session.step === 'body') {
            if (!text) {
                await requestJson('sendMessage', { chat_id: chatId, text: 'Template message is required.' });
                return;
            }
            template.body = text;
        } else if (session.step === 'delay') {
            template.delay_seconds = normalizeTemplateDelaySeconds(text);
        }

        template.updated_at = new Date().toISOString();
        saveTemplates(templates);
        clearSession(chatId);
        await requestJson('sendMessage', {
            chat_id: chatId,
            text: `Template updated: ${template.name || 'Untitled Template'}`,
            reply_markup: {
                inline_keyboard: makeTemplateDoneKeyboard(),
            },
        });
        await showTemplateDetail(chatId, String(template.id || ''));
    }
}

function findDuplicate(leads, phone, adLink) {
    return leads.find((lead) => {
        const samePhone = phone && lead.phone === phone;
        const sameAd = adLink && String(lead.ad_link || '').toLowerCase() === adLink.toLowerCase();
        return samePhone || sameAd;
    });
}

function saveLead(parsed, chatId, selectedTemplate = null) {
    const leads = readJson(leadsFile, []);
    const existing = findDuplicate(leads, parsed.phone, parsed.adLink);
    const template = selectedTemplate || getDefaultTemplate();
    const now = new Date().toISOString();

    if (existing) {
        if (selectedTemplate) {
            existing.message_template = selectedTemplate.body;
            existing.message_delay_seconds = selectedTemplate.delaySeconds;
            existing.updated_at = now;
            writeJson(leadsFile, leads);
        }
        return { lead: existing, created: false };
    }

    const lead = {
        id: crypto.randomBytes(8).toString('hex'),
        company: parsed.company,
        phone: parsed.phone,
        ad_link: parsed.adLink,
        source: 'Telegram',
        status: 'New',
        notes: `Imported from Telegram chat ${chatId}.`,
        message_template: template.body,
        message_delay_seconds: template.delaySeconds,
        whatsapp_send_status: 'not_sent',
        whatsapp_send_error: '',
        whatsapp_sent_at: '',
        telegram_chat_id: String(chatId),
        created_at: now,
        updated_at: now,
    };

    leads.push(lead);
    writeJson(leadsFile, leads);
    return { lead, created: true };
}

function findLeadById(leadId) {
    return readJson(leadsFile, []).find((lead) => lead.id === leadId) || null;
}

function updateLeadStatus(leadId, sendStatus, error = '') {
    const leads = readJson(leadsFile, []);
    const now = new Date().toISOString();
    let updated = false;

    for (const lead of leads) {
        if (lead.id !== leadId) {
            continue;
        }
        lead.whatsapp_send_status = sendStatus;
        lead.whatsapp_send_error = sendStatus === 'failed' ? error : '';
        lead.updated_at = now;
        if (sendStatus === 'sent') {
            lead.status = 'WhatsApp Sent';
            lead.whatsapp_sent_at = now;
        }
        updated = true;
        break;
    }

    if (updated) {
        writeJson(leadsFile, leads);
    }
    return updated;
}

function buildWhatsappUrl(lead) {
    const message = renderMessage(lead.message_template, lead);
    return `https://wa.me/${encodeURIComponent(lead.phone)}?text=${encodeURIComponent(message)}`;
}

function whatsappBridgeSend(payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = http.request({
            hostname: '127.0.0.1',
            port: whatsappBridgePort,
            path: '/send',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 120000,
        }, (res) => {
            let response = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                response += chunk;
            });
            res.on('end', () => {
                try {
                    const data = JSON.parse(response);
                    if (!res.statusCode || res.statusCode >= 400 || data.ok !== true) {
                        reject(new Error(data.error || `WhatsApp bridge returned ${res.statusCode}.`));
                        return;
                    }
                    resolve(data);
                } catch (error) {
                    reject(new Error('Invalid WhatsApp bridge response.'));
                }
            });
        });

        req.on('timeout', () => req.destroy(new Error('WhatsApp bridge request timed out.')));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function sendLeadWhatsapp(leadId) {
    const lead = findLeadById(leadId);
    if (!lead) {
        return { ok: false, error: 'Lead was not found.' };
    }

    const message = renderMessage(lead.message_template, lead);
    const messages = splitMessageParts(message);

    try {
        const result = await whatsappBridgeSend({
            phone: lead.phone,
            message,
            messages,
            delaySeconds: lead.message_delay_seconds || 10,
        });
        updateLeadStatus(leadId, 'sent');
        return { ok: true, sent: result.sent || messages.length || 1, lead };
    } catch (error) {
        const messageText = error.message || 'Could not send WhatsApp.';
        updateLeadStatus(leadId, 'failed', messageText);
        return { ok: false, error: messageText, lead };
    }
}

async function sendLeadPrompt(chatId, parsed) {
    if (!/^60\d{8,11}$/.test(parsed.phone)) {
        await requestJson('sendMessage', {
            chat_id: chatId,
            text: [
                'I could not find a valid Malaysia WhatsApp number.',
                '',
                'Send like this:',
                'Name: Company Name',
                'Contact: 60123456789',
                'Link: https://example.com/ad',
            ].join('\n'),
        });
        return;
    }

    const { lead, created } = saveLead(parsed, chatId, parsed.template || null);
    const title = lead.company || 'Untitled lead';
    const reply = [
        `${created ? 'Saved' : 'Already saved'}: ${title}`,
        `LeadTracker ID: ${lead.id}`,
        `Contact: ${lead.phone}`,
        lead.ad_link ? `Link: ${lead.ad_link}` : '',
        parsed.template?.name ? `Template: ${parsed.template.name}` : '',
        '',
        'Send WhatsApp now?',
    ].filter(Boolean).join('\n');

    await requestJson('sendMessage', {
        chat_id: chatId,
        text: reply,
        reply_markup: {
            inline_keyboard: makeLeadDoneKeyboard(lead),
        },
    });
}

async function finishLeadSession(chatId, session, template = null) {
    const parsed = {
        company: session.company,
        phone: session.phone,
        adLink: session.adLink,
        template,
    };
    clearSession(chatId);
    await sendLeadPrompt(chatId, parsed);
    processedCount += 1;
}

async function handleLeadStep(message) {
    const chatId = message.chat.id;
    const text = getChatText(message);
    const session = getSession(chatId) || createSession(chatId);

    if (session.step === 'phone') {
        const phone = getChatPhone(message);
        if (!/^60\d{8,11}$/.test(phone)) {
            await requestJson('sendMessage', {
                chat_id: chatId,
                text: 'Phone number not valid. Send Malaysia WhatsApp number like 60123456789.',
            });
            return;
        }
        session.phone = phone;
        session.step = 'adLink';
        await askAdLink(chatId);
        return;
    }

    if (session.step === 'adLink') {
        const adLink = cleanUrl(text);
        if (!adLink) {
            await requestJson('sendMessage', {
                chat_id: chatId,
                text: 'Ads link not valid. Send a link, or tap Skip ads link.',
                reply_markup: {
                    inline_keyboard: [[
                        { text: 'Skip ads link', callback_data: 'skip:adLink' },
                    ]],
                },
            });
            return;
        }
        session.adLink = adLink;
        session.step = 'company';
        await askName(chatId);
        return;
    }

    if (session.step === 'company') {
        session.company = text;
        await askTemplate(chatId, session);
    }
}

async function handleUpdate(update) {
    if (update.message) {
        const text = getChatText(update.message);
        const chatId = update.message.chat.id;
        if (text === '/cancel') {
            clearSession(chatId);
            await requestJson('sendMessage', {
                chat_id: chatId,
                text: 'Cancelled.',
            });
            return;
        }
        if (text === '/templates') {
            clearSession(chatId);
            await showTemplateManager(chatId);
            return;
        }
        if (text === '/start' || text === '/help' || text === '/new') {
            await startLeadFlow(chatId);
            return;
        }
        const session = getSession(chatId);
        if (session?.mode === 'template_add' || session?.mode === 'template_edit') {
            await handleTemplateSessionMessage(update.message, session);
            return;
        }
        await handleLeadStep(update.message);
        return;
    }

    if (update.callback_query) {
        const data = String(update.callback_query.data || '');
        const chatId = update.callback_query.message.chat.id;
        const session = getSession(chatId);

        if (data === 'lead:new') {
            await requestJson('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: 'New lead',
            });
            clearSession(chatId);
            await startLeadFlow(chatId);
            return;
        }

        if (data === 'tm:list') {
            await requestJson('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: 'Templates',
            });
            await showTemplateManager(chatId);
            return;
        }

        if (data === 'tm:add') {
            await requestJson('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: 'Adding template',
            });
            await startTemplateAdd(chatId);
            return;
        }

        const templateViewMatch = data.match(/^tm:view:([a-f0-9]{16})$/);
        if (templateViewMatch) {
            await requestJson('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: 'Template',
            });
            await showTemplateDetail(chatId, templateViewMatch[1]);
            return;
        }

        const templateEditMatch = data.match(/^tm:edit:(name|body|delay):([a-f0-9]{16})$/);
        if (templateEditMatch) {
            await requestJson('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: 'Editing template',
            });
            await startTemplateEdit(chatId, templateEditMatch[2], templateEditMatch[1]);
            return;
        }

        const templateDeleteMatch = data.match(/^tm:del:([a-f0-9]{16})$/);
        if (templateDeleteMatch) {
            const template = findTemplate(loadTemplates(), templateDeleteMatch[1]);
            await requestJson('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: 'Confirm delete',
            });
            await requestJson('sendMessage', {
                chat_id: chatId,
                text: `Delete template "${template?.name || 'Untitled Template'}"?`,
                reply_markup: {
                    inline_keyboard: [[
                        { text: 'Confirm Delete', callback_data: `tm:confirmdel:${templateDeleteMatch[1]}` },
                        { text: 'Cancel', callback_data: `tm:view:${templateDeleteMatch[1]}` },
                    ]],
                },
            });
            return;
        }

        const templateConfirmDeleteMatch = data.match(/^tm:confirmdel:([a-f0-9]{16})$/);
        if (templateConfirmDeleteMatch) {
            const templates = loadTemplates();
            const template = findTemplate(templates, templateConfirmDeleteMatch[1]);
            saveTemplates(templates.filter((item) => String(item.id || '') !== templateConfirmDeleteMatch[1]));
            await requestJson('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: 'Template deleted',
            });
            await requestJson('sendMessage', {
                chat_id: chatId,
                text: `Template deleted: ${template?.name || 'Untitled Template'}`,
                reply_markup: {
                    inline_keyboard: makeTemplateDoneKeyboard(),
                },
            });
            await showTemplateManager(chatId);
            return;
        }

        if (data === 'skip:adLink' && session?.step === 'adLink') {
            session.adLink = '';
            session.step = 'company';
            await requestJson('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: 'Ads link skipped.',
            });
            await askName(chatId);
            return;
        }

        if (data === 'skip:company' && session?.step === 'company') {
            session.company = '';
            await requestJson('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: 'Name skipped.',
            });
            await askTemplate(chatId, session);
            return;
        }

        if (data.startsWith('tpl:') && session?.step === 'template') {
            const selected = data === 'tpl:default'
                ? getDefaultTemplate()
                : session.templates[Number.parseInt(data.slice(4), 10)];
            await requestJson('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: selected ? `Selected ${selected.name}` : 'Using default template.',
            });
            await finishLeadSession(chatId, session, selected || getDefaultTemplate());
            return;
        }

        const sendWhatsappMatch = data.match(/^sendwa:([a-f0-9]{16})$/);
        if (sendWhatsappMatch) {
            await requestJson('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: 'Sending WhatsApp from LeadTracker...',
            });
            const sendingLead = findLeadById(sendWhatsappMatch[1]);
            await requestJson('sendMessage', {
                chat_id: chatId,
                text: sendingLead
                    ? `Sending WhatsApp to ${sendingLead.phone}...`
                    : 'Sending WhatsApp...',
            });
            const result = await sendLeadWhatsapp(sendWhatsappMatch[1]);
            if (result.ok) {
                await requestJson('sendMessage', {
                    chat_id: chatId,
                    text: `Sent ${result.sent} WhatsApp message${result.sent === 1 ? '' : 's'} and updated LeadTracker.`,
                    reply_markup: {
                        inline_keyboard: makeQuickDoneKeyboard(),
                    },
                });
                await requestJson('editMessageReplyMarkup', {
                    chat_id: update.callback_query.message.chat.id,
                    message_id: update.callback_query.message.message_id,
                    reply_markup: { inline_keyboard: [] },
                });
            } else {
                await requestJson('sendMessage', {
                    chat_id: chatId,
                    text: `WhatsApp failed: ${result.error}`,
                    reply_markup: result.lead ? {
                        inline_keyboard: [[
                            { text: 'Try Send WhatsApp Again', callback_data: `sendwa:${result.lead.id}` },
                        ], [
                            { text: 'Open WhatsApp', url: buildWhatsappUrl(result.lead) },
                            { text: 'Open LeadTracker', url: appUrl },
                        ], [
                            { text: '/new', callback_data: 'lead:new' },
                            { text: 'Templates', callback_data: 'tm:list' },
                        ]],
                    } : undefined,
                });
            }
            return;
        }

        const match = data.match(/^sent:([a-f0-9]{16})$/);
        if (match && updateLeadStatus(match[1], 'sent')) {
            await requestJson('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: 'Marked as WhatsApp Sent.',
            });
            await requestJson('editMessageReplyMarkup', {
                chat_id: update.callback_query.message.chat.id,
                message_id: update.callback_query.message.message_id,
                reply_markup: { inline_keyboard: [] },
            });
            await requestJson('sendMessage', {
                chat_id: chatId,
                text: 'Ready for next action.',
                reply_markup: {
                    inline_keyboard: makeQuickDoneKeyboard(),
                },
            });
        } else {
            await requestJson('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: 'Lead was not found.',
            });
        }
    }
}

async function poll() {
    if (!token) {
        return;
    }

    try {
        const updates = await requestJson('getUpdates', {
            offset,
            timeout: 25,
            allowed_updates: ['message', 'callback_query'],
        });

        status = 'ready';
        statusMessage = 'Telegram bridge is connected.';
        lastError = '';

        for (const update of updates) {
            offset = update.update_id + 1;
            try {
                await handleUpdate(update);
            } catch (error) {
                lastError = error.message || String(error);
                console.error(error);
            }
        }
    } catch (error) {
        status = 'error';
        statusMessage = 'Telegram bridge could not reach Telegram.';
        lastError = error.message || String(error);
    } finally {
        setImmediate(poll);
    }
}

async function startBot() {
    if (!token) {
        return;
    }

    try {
        const me = await requestJson('getMe');
        botName = me.username ? `@${me.username}` : me.first_name || '';
        status = 'ready';
        statusMessage = `Telegram bridge is connected${botName ? ` as ${botName}` : ''}.`;
    } catch (error) {
        status = 'error';
        statusMessage = 'Telegram bridge could not start.';
        lastError = error.message || String(error);
    }
    poll();
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/status') {
        res.end(JSON.stringify({
            ok: true,
            status,
            statusMessage,
            botName,
            lastError,
            processedCount,
        }));
        return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'Not found.' }));
});

server.listen(port, '127.0.0.1', () => {
    console.log(`LeadTracker Telegram bridge running at http://127.0.0.1:${port}`);
    startBot();
});
