const phoneInput = document.querySelector('#phone');
let waReady = false;

const leadModalElement = document.querySelector('#leadModal');
if (leadModalElement?.dataset.openOnLoad === 'true' && window.bootstrap) {
    bootstrap.Modal.getOrCreateInstance(leadModalElement).show();
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

if (phoneInput) {
    phoneInput.addEventListener('blur', () => {
        phoneInput.value = normalizePhone(phoneInput.value);
    });
}

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

        button.disabled = true;
        button.textContent = 'Sending...';

        if (!waReady) {
            window.open(fallbackUrl, '_blank', 'noopener');
            await markLeadSent(leadId);
            button.disabled = false;
            button.textContent = 'Send WhatsApp';
            return;
        }

        try {
            const response = await fetch('index.php?api=wa_send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, message }),
            });
            const payload = await response.json();
            if (!response.ok || !payload.ok) {
                throw new Error(payload.error || 'Could not send WhatsApp.');
            }
            await markLeadSent(leadId);
            showToast('WhatsApp sent from LeadTracker.');
            window.setTimeout(() => window.location.reload(), 700);
        } catch (error) {
            showToast(error.message || 'WhatsApp bridge failed. Opening WhatsApp Web.');
            window.open(fallbackUrl, '_blank', 'noopener');
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

async function markLeadSent(leadId) {
    const body = new URLSearchParams({ action: 'mark_sent', id: leadId });
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
