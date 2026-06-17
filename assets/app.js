const phoneInput = document.querySelector('#phone');

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
    button.addEventListener('click', () => {
        const url = button.getAttribute('data-send-whatsapp') || 'https://web.whatsapp.com/';
        const leadId = button.getAttribute('data-lead-id') || '';
        const tab = window.open('about:blank', '_blank', 'noopener');
        const body = new URLSearchParams({ action: 'mark_sent', id: leadId });

        fetch('index.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        }).finally(() => {
            if (tab) {
                tab.location = url;
            } else {
                window.location.href = url;
            }
        });
    });
});
