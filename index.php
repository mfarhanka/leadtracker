<?php
declare(strict_types=1);

$appName = 'LeadTracker';
$dataDir = __DIR__ . DIRECTORY_SEPARATOR . 'data';
$dataFile = $dataDir . DIRECTORY_SEPARATOR . 'leads.json';

if (!is_dir($dataDir)) {
    mkdir($dataDir, 0775, true);
}

function load_leads(string $file): array
{
    if (!file_exists($file)) {
        return [];
    }

    $contents = file_get_contents($file);
    if ($contents === false || trim($contents) === '') {
        return [];
    }

    $data = json_decode($contents, true);
    return is_array($data) ? $data : [];
}

function save_leads(string $file, array $leads): void
{
    file_put_contents($file, json_encode(array_values($leads), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
}

function normalize_phone(string $phone): string
{
    $digits = preg_replace('/\D+/', '', $phone) ?? '';

    if (str_starts_with($digits, '00')) {
        $digits = substr($digits, 2);
    }

    if (str_starts_with($digits, '0')) {
        return '6' . $digits;
    }

    if (str_starts_with($digits, '1')) {
        return '60' . $digits;
    }

    return $digits;
}

function format_phone(string $phone): string
{
    $phone = normalize_phone($phone);
    if (preg_match('/^(60)(\d{2})(\d{3,4})(\d{4})$/', $phone, $parts)) {
        return "+{$parts[1]} {$parts[2]} {$parts[3]} {$parts[4]}";
    }

    return $phone;
}

function clean_url(string $url): string
{
    $url = trim($url);
    if ($url === '') {
        return '';
    }

    if (!preg_match('/^https?:\/\//i', $url)) {
        $url = 'https://' . $url;
    }

    return filter_var($url, FILTER_VALIDATE_URL) ? $url : '';
}

function build_message(array $lead): string
{
    $company = trim((string)($lead['company'] ?? ''));
    $adLink = trim((string)($lead['ad_link'] ?? ''));

    $lines = [
        'Hi' . ($company !== '' ? " {$company}" : '') . ', saya berminat nak tanya tentang kerja yang diiklankan.',
        $adLink !== '' ? 'Saya jumpa iklan ini: ' . $adLink : '',
        'Boleh saya tahu masih ada kekosongan dan bagaimana cara untuk apply?',
        'Terima kasih.',
    ];

    return implode("\n", array_filter($lines, static fn (string $line): bool => trim($line) !== ''));
}

function find_duplicate(array $leads, string $phone, string $adLink, ?string $ignoreId = null): ?array
{
    foreach ($leads as $lead) {
        if ($ignoreId !== null && ($lead['id'] ?? '') === $ignoreId) {
            continue;
        }

        $samePhone = ($lead['phone'] ?? '') === $phone;
        $sameAd = $adLink !== '' && strcasecmp((string)($lead['ad_link'] ?? ''), $adLink) === 0;

        if ($samePhone || $sameAd) {
            return $lead;
        }
    }

    return null;
}

$leads = load_leads($dataFile);
$flash = null;
$errors = [];
$editing = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? 'save';

    if ($action === 'delete') {
        $id = (string)($_POST['id'] ?? '');
        $leads = array_values(array_filter($leads, static fn (array $lead): bool => ($lead['id'] ?? '') !== $id));
        save_leads($dataFile, $leads);
        header('Location: index.php?deleted=1');
        exit;
    }

    if ($action === 'mark_sent') {
        $id = (string)($_POST['id'] ?? '');
        foreach ($leads as $index => $lead) {
            if (($lead['id'] ?? '') === $id) {
                $leads[$index]['status'] = 'WhatsApp Sent';
                $leads[$index]['updated_at'] = date('c');
                break;
            }
        }

        save_leads($dataFile, $leads);
        header('Content-Type: application/json');
        echo json_encode(['ok' => true]);
        exit;
    }

    $id = trim((string)($_POST['id'] ?? ''));
    $company = trim((string)($_POST['company'] ?? ''));
    $phone = normalize_phone((string)($_POST['phone'] ?? ''));
    $adLink = clean_url((string)($_POST['ad_link'] ?? ''));
    $source = trim((string)($_POST['source'] ?? ''));
    $status = trim((string)($_POST['status'] ?? 'New'));
    $notes = trim((string)($_POST['notes'] ?? ''));

    if ($company === '') {
        $errors[] = 'Company name is required.';
    }

    if (!preg_match('/^60\d{8,11}$/', $phone)) {
        $errors[] = 'Phone number must be a valid Malaysia format, for example 60107744530.';
    }

    if ($adLink === '') {
        $errors[] = 'A valid ad link is required.';
    }

    $duplicate = find_duplicate($leads, $phone, $adLink, $id !== '' ? $id : null);
    if ($duplicate !== null) {
        $errors[] = 'Possible duplicate: ' . ($duplicate['company'] ?? 'existing lead') . ' already uses this phone number or ad link.';
    }

    if ($errors === []) {
        $now = date('c');
        $lead = [
            'id' => $id !== '' ? $id : bin2hex(random_bytes(8)),
            'company' => $company,
            'phone' => $phone,
            'ad_link' => $adLink,
            'source' => $source !== '' ? $source : 'Other',
            'status' => $status !== '' ? $status : 'New',
            'notes' => $notes,
            'created_at' => $now,
            'updated_at' => $now,
        ];

        $updated = false;
        foreach ($leads as $index => $existing) {
            if (($existing['id'] ?? '') === $lead['id']) {
                $lead['created_at'] = $existing['created_at'] ?? $now;
                $leads[$index] = $lead;
                $updated = true;
                break;
            }
        }

        if (!$updated) {
            $leads[] = $lead;
        }

        save_leads($dataFile, $leads);
        header('Location: index.php?saved=1');
        exit;
    }
}

if (isset($_GET['edit'])) {
    $editId = (string)$_GET['edit'];
    foreach ($leads as $lead) {
        if (($lead['id'] ?? '') === $editId) {
            $editing = $lead;
            break;
        }
    }
}

if (isset($_GET['saved'])) {
    $flash = 'Lead saved. You can send WhatsApp from the list.';
}
if (isset($_GET['deleted'])) {
    $flash = 'Lead deleted.';
}

$query = trim((string)($_GET['q'] ?? ''));
$statusFilter = trim((string)($_GET['status'] ?? ''));
$filteredLeads = array_values(array_filter($leads, static function (array $lead) use ($query, $statusFilter): bool {
    if ($statusFilter !== '' && ($lead['status'] ?? '') !== $statusFilter) {
        return false;
    }

    if ($query === '') {
        return true;
    }

    $haystack = strtolower(implode(' ', [
        $lead['company'] ?? '',
        $lead['phone'] ?? '',
        $lead['ad_link'] ?? '',
        $lead['source'] ?? '',
        $lead['notes'] ?? '',
    ]));

    return str_contains($haystack, strtolower($query));
}));

usort($filteredLeads, static fn (array $a, array $b): int => strcmp((string)($b['updated_at'] ?? ''), (string)($a['updated_at'] ?? '')));

$form = [
    'id' => $editing['id'] ?? ($_POST['id'] ?? ''),
    'company' => $editing['company'] ?? ($_POST['company'] ?? ''),
    'phone' => $editing['phone'] ?? ($_POST['phone'] ?? ''),
    'ad_link' => $editing['ad_link'] ?? ($_POST['ad_link'] ?? ''),
    'source' => $editing['source'] ?? ($_POST['source'] ?? 'Mudah.my'),
    'status' => $editing['status'] ?? ($_POST['status'] ?? 'New'),
    'notes' => $editing['notes'] ?? ($_POST['notes'] ?? ''),
];

$statuses = ['New', 'WhatsApp Sent', 'Replied', 'Applied', 'Rejected', 'No Response'];
$sources = ['Mudah.my', 'Carousell', 'Facebook Marketplace', 'Other'];
?>
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?= htmlspecialchars($appName) ?></title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="assets/app.css" rel="stylesheet">
</head>
<body>
<nav class="navbar navbar-expand-lg bg-white border-bottom sticky-top">
    <div class="container-fluid px-3 px-lg-4">
        <a class="navbar-brand fw-bold" href="index.php"><?= htmlspecialchars($appName) ?></a>
        <div class="d-flex align-items-center gap-2 small text-secondary">
            <span><?= count($leads) ?> saved</span>
            <span class="connection-dot" id="waConnectionDot"></span>
            <span id="waConnectionText">WhatsApp bridge offline</span>
        </div>
    </div>
</nav>

<main class="container-fluid px-3 px-lg-4 py-4">
    <?php if ($flash): ?>
        <div class="alert alert-success"><?= htmlspecialchars($flash) ?></div>
    <?php endif; ?>

    <?php if ($errors !== []): ?>
        <div class="alert alert-danger">
            <strong>Please check:</strong>
            <ul class="mb-0">
                <?php foreach ($errors as $error): ?>
                    <li><?= htmlspecialchars($error) ?></li>
                <?php endforeach; ?>
            </ul>
        </div>
    <?php endif; ?>

    <div class="row g-4 align-items-start">
        <section class="col-12 col-xl-4">
            <div class="panel mb-4">
                <div class="d-flex justify-content-between align-items-start gap-3 mb-3">
                    <div>
                        <h1 class="h5 mb-1">WhatsApp QR</h1>
                        <p class="text-secondary small mb-0" id="waStatusText">Start the bridge, then scan the QR here.</p>
                    </div>
                    <button class="btn btn-outline-primary btn-sm" type="button" id="waRefreshButton">Refresh</button>
                </div>
                <div class="qr-box" id="waQrBox">
                    <div class="text-secondary small text-center px-3">Run <code>start-whatsapp-bridge.bat</code> to show the QR.</div>
                </div>
                <div class="small text-secondary mt-3">
                    Connected number: <span id="waConnectedNumber">-</span>
                </div>
            </div>

            <div class="panel">
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h2 class="h4 mb-0"><?= $editing ? 'Edit Lead' : 'Add Lead' ?></h2>
                    <?php if ($editing): ?>
                        <a class="btn btn-outline-secondary btn-sm" href="index.php">Cancel</a>
                    <?php endif; ?>
                </div>

                <form method="post" class="vstack gap-3" id="leadForm">
                    <input type="hidden" name="id" value="<?= htmlspecialchars((string)$form['id']) ?>">
                    <input type="hidden" name="action" value="save">

                    <div>
                        <label class="form-label" for="company">Company / Contact Name</label>
                        <input class="form-control" id="company" name="company" value="<?= htmlspecialchars((string)$form['company']) ?>" required autocomplete="organization">
                    </div>

                    <div>
                        <label class="form-label" for="phone">WhatsApp Number</label>
                        <input class="form-control" id="phone" name="phone" value="<?= htmlspecialchars((string)$form['phone']) ?>" placeholder="60107744530" required inputmode="tel" autocomplete="tel">
                        <div class="form-text">Accepts 0107744530, +60107744530, or 60107744530. Saved as 60 format.</div>
                    </div>

                    <div>
                        <label class="form-label" for="ad_link">Ad Link</label>
                        <input class="form-control" id="ad_link" name="ad_link" value="<?= htmlspecialchars((string)$form['ad_link']) ?>" placeholder="https://..." required inputmode="url">
                    </div>

                    <div class="row g-3">
                        <div class="col-md-6">
                            <label class="form-label" for="source">Source</label>
                            <select class="form-select" id="source" name="source">
                                <?php foreach ($sources as $source): ?>
                                    <option value="<?= htmlspecialchars($source) ?>" <?= $form['source'] === $source ? 'selected' : '' ?>><?= htmlspecialchars($source) ?></option>
                                <?php endforeach; ?>
                            </select>
                        </div>
                        <div class="col-md-6">
                            <label class="form-label" for="status">Status</label>
                            <select class="form-select" id="status" name="status">
                                <?php foreach ($statuses as $status): ?>
                                    <option value="<?= htmlspecialchars($status) ?>" <?= $form['status'] === $status ? 'selected' : '' ?>><?= htmlspecialchars($status) ?></option>
                                <?php endforeach; ?>
                            </select>
                        </div>
                    </div>

                    <div>
                        <label class="form-label" for="notes">Notes</label>
                        <textarea class="form-control" id="notes" name="notes" rows="3" placeholder="Role, salary, location, follow-up..."><?= htmlspecialchars((string)$form['notes']) ?></textarea>
                    </div>

                    <button class="btn btn-primary w-100" type="submit"><?= $editing ? 'Update Lead' : 'Save Lead' ?></button>
                </form>
            </div>
        </section>

        <section class="col-12 col-xl-8">
            <div class="toolbar mb-3">
                <form class="row g-2 align-items-center" method="get">
                    <div class="col-12 col-lg">
                        <input class="form-control" name="q" value="<?= htmlspecialchars($query) ?>" placeholder="Search company, phone, ad link, notes">
                    </div>
                    <div class="col-7 col-lg-3">
                        <select class="form-select" name="status">
                            <option value="">All statuses</option>
                            <?php foreach ($statuses as $status): ?>
                                <option value="<?= htmlspecialchars($status) ?>" <?= $statusFilter === $status ? 'selected' : '' ?>><?= htmlspecialchars($status) ?></option>
                            <?php endforeach; ?>
                        </select>
                    </div>
                    <div class="col-5 col-lg-auto">
                        <button class="btn btn-outline-primary w-100" type="submit">Filter</button>
                    </div>
                </form>
            </div>

            <div class="lead-list">
                <?php if ($filteredLeads === []): ?>
                    <div class="empty-state">
                        <h2 class="h5">No leads yet</h2>
                        <p class="mb-0 text-secondary">Save companies from Mudah.my, Carousell, or Facebook Marketplace, then send WhatsApp from here.</p>
                    </div>
                <?php endif; ?>

                <?php foreach ($filteredLeads as $lead): ?>
                    <?php
                    $message = build_message($lead);
                    $waUrl = 'https://web.whatsapp.com/send?phone=' . rawurlencode((string)$lead['phone']) . '&text=' . rawurlencode($message);
                    ?>
                    <article class="lead-card">
                        <div class="d-flex flex-column flex-lg-row gap-3 justify-content-between">
                            <div class="min-w-0">
                                <div class="d-flex flex-wrap align-items-center gap-2 mb-1">
                                    <h2 class="h5 mb-0 text-truncate"><?= htmlspecialchars((string)$lead['company']) ?></h2>
                                    <span class="badge text-bg-light border"><?= htmlspecialchars((string)$lead['source']) ?></span>
                                    <span class="badge status-badge"><?= htmlspecialchars((string)$lead['status']) ?></span>
                                </div>
                                <div class="small text-secondary mb-2"><?= htmlspecialchars(format_phone((string)$lead['phone'])) ?></div>
                                <a class="ad-link" href="<?= htmlspecialchars((string)$lead['ad_link']) ?>" target="_blank" rel="noopener"><?= htmlspecialchars((string)$lead['ad_link']) ?></a>
                                <?php if (trim((string)$lead['notes']) !== ''): ?>
                                    <p class="notes mb-0 mt-2"><?= nl2br(htmlspecialchars((string)$lead['notes'])) ?></p>
                                <?php endif; ?>
                            </div>

                            <div class="actions">
                                <button class="btn btn-success" type="button" data-send-whatsapp="<?= htmlspecialchars($waUrl) ?>" data-lead-id="<?= htmlspecialchars((string)$lead['id']) ?>" data-phone="<?= htmlspecialchars((string)$lead['phone']) ?>" data-message="<?= htmlspecialchars($message) ?>">Send WhatsApp</button>
                                <button class="btn btn-outline-secondary" type="button" data-template="<?= htmlspecialchars($message) ?>">Copy Template</button>
                                <a class="btn btn-outline-primary" href="index.php?edit=<?= urlencode((string)$lead['id']) ?>">Edit</a>
                                <form method="post" onsubmit="return confirm('Delete this lead?');">
                                    <input type="hidden" name="action" value="delete">
                                    <input type="hidden" name="id" value="<?= htmlspecialchars((string)$lead['id']) ?>">
                                    <button class="btn btn-outline-danger" type="submit">Delete</button>
                                </form>
                            </div>
                        </div>
                    </article>
                <?php endforeach; ?>
            </div>
        </section>
    </div>
</main>

<div class="toast-container position-fixed bottom-0 end-0 p-3">
    <div id="copyToast" class="toast" role="status" aria-live="polite" aria-atomic="true">
        <div class="toast-body">Template copied.</div>
    </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script src="assets/app.js"></script>
</body>
</html>
