const phoneInput = document.querySelector('#phone');
let waReady = false;
const templates = loadTemplates();

function loadTemplates() {
    const data = document.querySelector('#templateData');
    if (!data) {
        return new Map();
    }

    try {
        const parsed = JSON.parse(data.textContent || '[]');
        return new Map(parsed.map((template) => [String(template.id || ''), template]));
    } catch (error) {
        return new Map();
    }
}

const leadModalElement = document.querySelector('#leadModal');
if (leadModalElement?.dataset.openOnLoad === 'true' && window.bootstrap) {
    bootstrap.Modal.getOrCreateInstance(leadModalElement).show();
}

const templatesModalElement = document.querySelector('#templatesModal');
if (templatesModalElement?.dataset.openOnLoad === 'true' && window.bootstrap) {
    bootstrap.Modal.getOrCreateInstance(templatesModalElement).show();
}

function normalizePhone(value) {
    let digits = value.replace(/\D+/g, '');

    if (digits.startsWith('00')) {
        digits = digits.slice(2);
    }

    if (digits.startsWith('0')) {
        return `6${digits}`;
    }

    if (digits.startsWith('1')) {
        return `60${digits}`;
    }

    return digits;
}

function splitMessageParts(message) {
    return String(message || '')
        .split(/^\s*---\s*$/m)
        .map((part) => part.trim())
        .filter(Boolean);
}

if (phoneInput) {
    phoneInput.addEventListener('blur', () => {
        phoneInput.value = normalizePhone(phoneInput.value);
    });
}

const templatePicker = document.querySelector('#template_picker');
if (templatePicker) {
    templatePicker.addEventListener('change', () => {
        const option = templatePicker.selectedOptions[0];
        if (!option || option.value === '') {
            return;
        }

        const messageTemplate = document.querySelector('#message_template');
        const delayInput = document.querySelector('#message_delay_seconds');
        const template = templates.get(option.value);

        if (messageTemplate) {
            messageTemplate.value = template?.body || option.dataset.templateBody || '';
        }

        if (delayInput) {
            delayInput.value = String(template?.delay_seconds ?? option.dataset.templateDelay ?? '10');
        }
    });
}

document.querySelectorAll('[data-edit-template]').forEach((button) => {
    button.addEventListener('click', () => {
        const templateId = document.querySelector('#template_id');
        const templateName = document.querySelector('#template_name');
        const templateBody = document.querySelector('#template_body');
        const templateDelay = document.querySelector('#template_delay_seconds');
        const template = templates.get(button.dataset.templateId || '');

        if (templateId) {
            templateId.value = button.dataset.templateId || '';
        }

        if (templateName) {
            templateName.value = template?.name || button.dataset.templateName || '';
        }

        if (templateBody) {
            templateBody.value = template?.body || button.dataset.templateBody || '';
        }

        if (templateDelay) {
            templateDelay.value = String(template?.delay_seconds ?? button.dataset.templateDelay ?? '10');
        }
    });
});

const newTemplateButton = document.querySelector('#newTemplateButton');
if (newTemplateButton) {
    newTemplateButton.addEventListener('click', () => {
        const templateForm = document.querySelector('#templateForm');
        const templateId = document.querySelector('#template_id');
        const templateName = document.querySelector('#template_name');
        const templateBody = document.querySelector('#template_body');
        const templateDelay = document.querySelector('#template_delay_seconds');

        if (templateId) {
            templateId.value = '';
        }

        if (templateName) {
            templateName.value = '';
            templateName.focus();
        }

        if (templateBody) {
            templateBody.value = templateForm?.dataset.defaultTemplate || '';
        }

        if (templateDelay) {
            templateDelay.value = '10';
        }
    });
}

document.querySelectorAll('[data-delete-template-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
        if (!window.confirm('Delete this template?')) {
            event.preventDefault();
        }
    });
});

document.querySelectorAll('[data-template]').forEach((button) => {
    button.addEventListener('click', async () => {
        const template = button.getAttribute('data-template') || '';
        await navigator.clipboard.writeText(template);

        const toastElement = document.querySelector('#copyToast');
        if (toastElement && window.bootstrap) {
            bootstrap.Toast.getOrCreateInstance(toastElement).show();
        }
    });
});

document.querySelectorAll('[data-send-whatsapp]').forEach((button) => {
    button.addEventListener('click', async () => {
        const fallbackUrl = button.getAttribute('data-send-whatsapp') || 'https://web.whatsapp.com/';
        const leadId = button.getAttribute('data-lead-id') || '';
        const phone = button.getAttribute('data-phone') || '';
        const message = button.getAttribute('data-message') || '';
        const messages = splitMessageParts(message);
        const delaySeconds = Number.parseInt(button.getAttribute('data-delay-seconds') || '10', 10);

        button.disabled = true;
        button.textContent = messages.length > 1 ? `Sending 1/${messages.length}...` : 'Sending...';

        if (!waReady) {
            if (messages.length === 1) {
                window.open(fallbackUrl, '_blank', 'noopener');
            }
            await updateLeadWhatsappStatus(leadId, 'failed', 'WhatsApp bridge is required for separate message sending.');
            showToast('WhatsApp bridge is required to send separate messages.');
            button.disabled = false;
            button.textContent = 'Send WhatsApp';
            return;
        }

        try {
            const response = await fetch('index.php?api=wa_send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phone,
                    message,
                    messages,
                    delaySeconds: Number.isFinite(delaySeconds) ? delaySeconds : 10,
                }),
            });
            const payload = await response.json();
            if (!response.ok || !payload.ok) {
                throw new Error(payload.error || 'Could not send WhatsApp.');
            }
            await updateLeadWhatsappStatus(leadId, 'sent');
            const sentCount = payload.sent || messages.length || 1;
            showToast(`Sent ${sentCount} WhatsApp message${sentCount === 1 ? '' : 's'} from LeadTracker.`);
            window.setTimeout(() => window.location.reload(), 700);
        } catch (error) {
            const message = error.message || 'WhatsApp bridge failed.';
            await updateLeadWhatsappStatus(leadId, 'failed', message);
            showToast(message);
            if (messages.length === 1) {
                window.open(fallbackUrl, '_blank', 'noopener');
            }
            window.setTimeout(() => window.location.reload(), 700);
        } finally {
            button.disabled = false;
            button.textContent = 'Send WhatsApp';
        }
    });
});

document.querySelectorAll('[data-delete-lead]').forEach((button) => {
    button.addEventListener('click', () => {
        const deleteId = document.querySelector('#deleteLeadId');
        const deleteName = document.querySelector('#deleteLeadName');

        if (deleteId) {
            deleteId.value = button.getAttribute('data-delete-lead') || '';
        }

        if (deleteName) {
            deleteName.textContent = button.getAttribute('data-delete-name') || 'this lead';
        }
    });
});

async function updateLeadWhatsappStatus(leadId, sendStatus, error = '') {
    if (!leadId) {
        return;
    }

    const body = new URLSearchParams({
        action: 'update_whatsapp_status',
        id: leadId,
        send_status: sendStatus,
        error,
    });
    await fetch('index.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
}

function showToast(message) {
    const toastElement = document.querySelector('#copyToast');
    if (!toastElement) {
        return;
    }

    const body = toastElement.querySelector('.toast-body');
    if (body) {
        body.textContent = message;
    }

    if (window.bootstrap) {
        bootstrap.Toast.getOrCreateInstance(toastElement).show();
    }
}

async function refreshWhatsappStatus() {
    const statusText = document.querySelector('#waStatusText');
    const qrBox = document.querySelector('#waQrBox');
    const connectedNumber = document.querySelector('#waConnectedNumber');
    const dot = document.querySelector('#waConnectionDot');
    const navText = document.querySelector('#waConnectionText');

    try {
        const response = await fetch('index.php?api=wa_status', { cache: 'no-store' });
        const payload = await response.json();
        waReady = payload.status === 'ready';

        if (statusText) {
            statusText.textContent = payload.statusMessage || 'WhatsApp bridge is running.';
        }

        if (connectedNumber) {
            connectedNumber.textContent = payload.connectedNumber || '-';
        }

        if (qrBox) {
            if (payload.qrDataUrl) {
                qrBox.innerHTML = `<img src="${payload.qrDataUrl}" alt="WhatsApp login QR">`;
            } else if (waReady) {
                qrBox.innerHTML = '<div class="text-success text-center px-3">Connected. You can send messages from LeadTracker.</div>';
            } else {
                qrBox.innerHTML = '<div class="text-secondary small text-center px-3">Waiting for WhatsApp QR...</div>';
            }
        }

        if (dot) {
            dot.classList.toggle('ready', waReady);
            dot.classList.toggle('waiting', !waReady);
        }

        if (navText) {
            navText.textContent = waReady ? 'WhatsApp connected' : 'WhatsApp waiting';
        }
    } catch (error) {
        waReady = false;
        if (statusText) {
            statusText.innerHTML = 'Bridge offline. Run <code>start-whatsapp-bridge.bat</code>.';
        }
        if (qrBox) {
            qrBox.innerHTML = '<div class="text-secondary small text-center px-3">Run <code>start-whatsapp-bridge.bat</code> to show the QR.</div>';
        }
        if (connectedNumber) {
            connectedNumber.textContent = '-';
        }
        if (dot) {
            dot.classList.remove('ready', 'waiting');
        }
        if (navText) {
            navText.textContent = 'WhatsApp bridge offline';
        }
    }
}

const waRefreshButton = document.querySelector('#waRefreshButton');
if (waRefreshButton) {
    waRefreshButton.addEventListener('click', refreshWhatsappStatus);
}

if (document.querySelector('#waQrBox')) {
    refreshWhatsappStatus();
    window.setInterval(refreshWhatsappStatus, 5000);
}
