#!/usr/bin/env node
/**
 * Dropbox Skill for PAVE
 * 
 * Access Dropbox files, folders, and Paper documents.
 * Uses PAVE sandbox with secure OAuth token handling.
 * Compatible with SpiderMonkey sandbox (no optional chaining, no async/await).
 */

var fs = require('fs');
var path = require('path');

/**
 * JSON.stringify for the Dropbox-API-Arg header. HTTP headers must be ASCII,
 * so every non-ASCII character (CJK paths etc.) is escaped as \\uXXXX per
 * Dropbox's "HTTP header safe JSON" requirement.
 */
function httpHeaderSafeJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, function(c) {
    return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

/**
 * Safe nested property access (replaces optional chaining)
 */
function safeGet(obj, path, defaultVal) {
  if (!obj) return defaultVal;
  var parts = path.split('.');
  var current = obj;
  for (var i = 0; i < parts.length; i++) {
    if (current === null || current === undefined) return defaultVal;
    current = current[parts[i]];
  }
  return current !== undefined ? current : defaultVal;
}

// Parse command line arguments  
var args = process.argv.slice(2);

function parseArgs() {
  var parsed = {
    command: null,
    positional: [],
    options: {}
  };
  
  for (var i = 0; i < args.length; i++) {
    var arg = args[i];
    if (arg.charAt(0) === '-') {
      if (arg.charAt(1) === '-') {
        // Long option
        var eqIdx = arg.indexOf('=');
        var key, value;
        if (eqIdx > 0) {
          key = arg.slice(2, eqIdx);
          value = arg.slice(eqIdx + 1);
        } else {
          key = arg.slice(2);
          if (i + 1 < args.length && args[i + 1].charAt(0) !== '-') {
            value = args[i + 1];
            i++;
          } else {
            value = true;
          }
        }
        parsed.options[key] = value;
      } else {
        // Short option
        var flag = arg.slice(1);
        if (i + 1 < args.length && args[i + 1].charAt(0) !== '-') {
          parsed.options[flag] = args[i + 1];
          i++;
        } else {
          parsed.options[flag] = true;
        }
      }
    } else {
      if (parsed.command === null) {
        parsed.command = arg;
      } else {
        parsed.positional.push(arg);
      }
    }
  }
  
  return parsed;
}

// Dropbox Client Class
function DropboxClient() {
  this.apiUrl = 'https://api.dropboxapi.com/2';
  this.contentUrl = 'https://content.dropboxapi.com/2';
  this.timeout = 30000;
}

/**
 * Make an authenticated request (uses secure token system)
 */
DropboxClient.prototype.authenticatedRequest = function(url, options) {
  options = options || {};
  
  // Use secure token system (handles all token management automatically)
  return proxyFetch('dropbox', url, options);
};

/**
 * Make an RPC-style request to Dropbox API
 */
DropboxClient.prototype.request = function(endpoint, body) {
  var url = this.apiUrl + endpoint;
  
  var options = {
    method: 'POST',
    headers: {},
    timeout: this.timeout
  };
  
  if (body !== null && body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  
  var response = this.authenticatedRequest(url, options);
  var text = response.text();
  
  if (!response.ok) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { error: text };
    }
    var errMsg = data.error_summary || data.error_description || 
                 safeGet(data, 'error.message', null) || text || 'API request failed';
    var err = new Error(errMsg);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  
  return text ? JSON.parse(text) : {};
};

/**
 * Make a content download request using a temporary link.
 *
 * The PAVE proxy's _domain routing for content.dropboxapi.com is unreliable
 * (~80% failure rate). Instead, we use /files/get_temporary_link (which works
 * reliably on the API domain) to get a short-lived direct download URL, then
 * fetch the file content from dl.dropboxusercontent.com via the proxy.
 *
 * For _saveTo mode, we download to a temp file first then move it to the
 * target path to avoid writing partial/error content to the destination.
 *
 * @param {string} endpoint - API endpoint (e.g. '/files/download')
 * @param {object} apiArg - Dropbox-API-Arg value (must include 'path')
 * @param {string} [saveTo] - If provided, save to this file path
 */
DropboxClient.prototype.downloadRequest = function(endpoint, apiArg, saveTo) {
  var filePath = apiArg && apiArg.path;
  if (!filePath) {
    throw new Error('Download requires a file path');
  }

  // Step 1: Get a temporary download link via the API domain (reliable)
  var linkResult = this.request('/files/get_temporary_link', { path: filePath });
  var downloadUrl = linkResult.link;

  // Step 2: Download the file content from the temporary link
  if (saveTo) {
    // Save directly using curl (no proxy needed for dl.dropboxusercontent.com)
    var tmpFile = saveTo + '.download';
    var curlCmd = 'curl -sS -L --max-time 60 -o ' + _shellQuote(tmpFile) + ' ' + _shellQuote(downloadUrl);
    var curlResult;
    try {
      curlResult = require('child_process').execSync(curlCmd, {
        encoding: 'utf8', timeout: 65000, maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      // curl may exit with non-zero on some errors but file might still exist
    }

    // Verify the downloaded file
    if (!fs.existsSync(tmpFile)) {
      throw new Error('Download failed: temporary file not created');
    }
    var stats = fs.statSync(tmpFile);
    if (stats.size < 50) {
      // Check if it's an HTML error page
      var peek = fs.readFileSync(tmpFile, { encoding: 'utf8', length: 50 });
      fs.unlinkSync(tmpFile);
      if (peek.indexOf('<!DOCTYPE') !== -1 || peek.indexOf('<html') !== -1) {
        throw new Error('Download failed: received HTML error page instead of file content');
      }
    }

    // Move temp file to final destination
    if (fs.existsSync(saveTo)) {
      fs.unlinkSync(saveTo);
    }
    fs.renameSync(tmpFile, saveTo);

    return { ok: true, status: 200, savedTo: saveTo,
      headers: { get: function() { return null; } },
      text: function() { return ''; }, json: function() { return {}; } };
  }

  // No saveTo: return content in memory
  var memCmd = 'curl -sS -L --max-time 60 ' + _shellQuote(downloadUrl);
  var content;
  try {
    content = require('child_process').execSync(memCmd, {
      encoding: 'utf8', timeout: 65000, maxBuffer: 100 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    var stderr = err.stderr ? err.stderr.toString() : '';
    throw new Error('Download failed: ' + (stderr || err.message));
  }

  // Parse the Dropbox-API-Result header from the metadata (not available in
  // temp link approach, but we have the metadata from get_temporary_link)
  var metadata = linkResult.metadata || {};
  var metadataJson = JSON.stringify(metadata);

  return { ok: true, status: 200,
    headers: { get: function(name) {
      if (name && name.toLowerCase() === 'dropbox-api-result') return metadataJson;
      return null;
    } },
    text: function() { return content; },
    json: function() { return JSON.parse(content || '{}'); } };
};

/**
 * Make a content upload request
 */
DropboxClient.prototype.uploadRequest = function(endpoint, apiArg, content) {
  var url = this.contentUrl + endpoint;
  
  var response = this.authenticatedRequest(url, {
    method: 'POST',
    headers: {
      'Dropbox-API-Arg': httpHeaderSafeJson(apiArg),
      'Content-Type': 'application/octet-stream'
    },
    body: content,
    timeout: this.timeout
  });
  
  var text = response.text();
  var data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { error: text };
  }
  
  if (!response.ok) {
    var err = new Error(data.error_summary || safeGet(data, 'error.message', null) || text || 'Upload failed');
    err.status = response.status;
    err.data = data;
    throw err;
  }
  
  return data;
};

/**
 * Get current account info
 */
DropboxClient.prototype.getCurrentAccount = function() {
  return this.request('/users/get_current_account', null);
};

/**
 * List folder contents
 */
DropboxClient.prototype.listFolder = function(folderPath, options) {
  options = options || {};
  return this.request('/files/list_folder', {
    path: folderPath || '',
    recursive: options.recursive || false,
    include_media_info: options.includeMediaInfo || false,
    include_deleted: options.includeDeleted || false,
    include_has_explicit_shared_members: false,
    include_mounted_folders: true,
    limit: options.limit || 100
  });
};

/**
 * Continue listing folder contents
 */
DropboxClient.prototype.listFolderContinue = function(cursor) {
  return this.request('/files/list_folder/continue', { cursor: cursor });
};

/**
 * Search for files and folders
 */
DropboxClient.prototype.search = function(query, options) {
  options = options || {};
  var body = {
    query: query,
    options: {
      max_results: options.maxResults || 20,
      file_status: 'active'
    }
  };
  
  if (options.path) {
    body.options.path = options.path;
  }
  
  if (options.fileExtensions) {
    body.options.file_extensions = options.fileExtensions;
  }
  
  if (options.fileCategories) {
    body.options.file_categories = options.fileCategories;
  }
  
  return this.request('/files/search_v2', body);
};

/**
 * Get file metadata
 */
DropboxClient.prototype.getMetadata = function(filePath) {
  return this.request('/files/get_metadata', {
    path: filePath,
    include_media_info: true
  });
};

/**
 * Upload a local file to Dropbox
 */
DropboxClient.prototype.uploadFile = function(localPath, dropboxPath, mode) {
  var content = fs.readFileSync(localPath);
  return this.uploadRequest('/files/upload', {
    path: dropboxPath,
    mode: mode || 'overwrite',
    autorename: false,
    mute: false
  }, content);
};

/**
 * Download a file
 * @param {string} filePath - Dropbox file path or ID
 * @param {string} [saveTo] - If provided, save directly to this local path via proxy
 */
DropboxClient.prototype.downloadFile = function(filePath, saveTo) {
  var response = this.downloadRequest('/files/download', { path: filePath }, saveTo);
  if (saveTo && response.savedTo) {
    return response.savedTo;
  }
  return response.text();
};

/**
 * List Paper docs
 */
DropboxClient.prototype.listPaperDocs = function(folderPath) {
  return this.search('.paper', {
    path: folderPath || undefined,
    maxResults: 100,
    fileExtensions: ['paper']
  });
};

/**
 * Get Paper doc content as markdown (or html).
 * Uses /files/export on the content domain directly.
 *
 * NOTE: Do NOT use downloadRequest() here because it calls
 * /files/get_temporary_link first, which returns unsupported_file
 * for .paper files. The /files/export content endpoint is the
 * only way to retrieve Paper document content.
 */
DropboxClient.prototype.getPaperDocContent = function(docPath, exportFormat, saveTo) {
  var url = this.contentUrl + '/files/export';
  var apiArg = {
    path: docPath,
    export_format: exportFormat || 'markdown'
  };
  
  var options = {
    method: 'POST',
    headers: {
      'Dropbox-API-Arg': httpHeaderSafeJson(apiArg),
      'Content-Type': 'application/octet-stream'
    },
    timeout: this.timeout
  };
  
  if (saveTo) {
    options.saveTo = saveTo;
  }
  
  var response = this.authenticatedRequest(url, options);
  
  if (saveTo && response.savedTo) {
    return response.savedTo;
  }
  
  return response.text();
};

/**
 * Search Paper docs by content
 */
DropboxClient.prototype.searchPaperDocs = function(query, options) {
  options = options || {};
  options.fileExtensions = ['paper'];
  return this.search(query, options);
};

/**
 * Create a new Paper document
 * Uses the documented Paper import endpoint /2/files/paper/create (API
 * domain), which parses markdown/html/plain_text into a real Paper document.
 * Raw /files/upload of a .paper path creates an ordinary file the Paper web
 * editor refuses to open ("This file type is unsupported here") — issue #3.
 *
 * Returns { url, result_path, file_id, paper_revision }.
 */
/**
 * The Paper API requires paths ending in lowercase ".paper" — uppercase
 * variants get invalid_file_extension (verified live). Append or lowercase
 * the extension as needed.
 */
function normalizePaperPath(docPath) {
  if (/\.paper$/.test(docPath)) return docPath;
  if (/\.paper$/i.test(docPath)) return docPath.replace(/\.paper$/i, '.paper');
  return docPath + '.paper';
}

DropboxClient.prototype.createPaperDoc = function(docPath, content, importFormat) {
  return this.paperRequest('/files/paper/create', {
    path: normalizePaperPath(docPath),
    import_format: importFormat || 'markdown'
  }, content);
};

/**
 * Update an existing Paper document via /2/files/paper/update.
 * Policy 'overwrite' (default) replaces the content. Policy 'update' appends;
 * the API then requires the current paper_revision, which is only exposed in
 * /files/export's Dropbox-API-Result header (not in /files/get_metadata).
 *
 * Returns { paper_revision }.
 */
DropboxClient.prototype.updatePaperDoc = function(docPath, content, importFormat, updatePolicy) {
  var policy = updatePolicy || 'overwrite';
  // Reject unknown policies loudly: a typo ("append", "Update") must not fall
  // through to overwrite, which silently replaces the whole document.
  if (policy !== 'update' && policy !== 'overwrite') {
    throw new Error('Invalid policy "' + policy + '": use "update" (append) or "overwrite" (replace)');
  }
  // Same normalization as createPaperDoc — the API addresses docs by .paper path
  docPath = normalizePaperPath(docPath);
  var apiArg = {
    path: docPath,
    import_format: importFormat || 'markdown',
    doc_update_policy: policy
  };
  if (policy === 'update') {
    apiArg.paper_revision = this.getPaperRevision(docPath);
  }
  try {
    return this.paperRequest('/files/paper/update', apiArg, content);
  } catch (err) {
    // safeGet can't address the '.tag' key (it splits its path on '.'), so
    // read it directly.
    var errTag = err.data && err.data.error ? err.data.error['.tag'] : null;
    if (errTag === 'revision_mismatch' ||
        (err.message && err.message.indexOf('revision_mismatch') !== -1)) {
      // No automatic retry: an append is not idempotent — if the update landed
      // but the response was lost, retrying would double-append.
      err.message += ' (the doc changed between revision lookup and append; re-run to append against the new revision)';
    }
    throw err;
  }
};

/**
 * Get the current paper_revision of a Paper doc from /files/export's
 * Dropbox-API-Result header (export_metadata.paper_revision).
 */
DropboxClient.prototype.getPaperRevision = function(docPath) {
  var response = this.authenticatedRequest(this.contentUrl + '/files/export', {
    method: 'POST',
    headers: {
      'Dropbox-API-Arg': httpHeaderSafeJson({ path: docPath, export_format: 'markdown' }),
      'Content-Type': 'application/octet-stream'
    },
    timeout: this.timeout
  });
  if (!response.ok) {
    // Surface the real export error (unsupported_file for a pre-1.8.0 plain
    // upload, path/not_found, transport flake) instead of blaming the doc type.
    var errText = response.text();
    var errData;
    try { errData = JSON.parse(errText); } catch (e) { errData = {}; }
    throw new Error('Cannot read current revision of ' + docPath + ': ' +
      (errData.error_summary || errText || ('export failed with status ' + response.status)));
  }
  var resultHeader = response.headers.get('dropbox-api-result');
  var meta = null;
  if (resultHeader) {
    try { meta = JSON.parse(resultHeader); } catch (e) { meta = null; }
  }
  var revision = safeGet(meta, 'export_metadata.paper_revision', null);
  if (revision === null || revision === undefined) {
    throw new Error('Could not determine paper_revision for ' + docPath +
      ' (export result header missing/unreadable — the doc may exceed the 10MB export buffer)');
  }
  return revision;
};

/**
 * Content-upload-style request on the API domain (Dropbox-API-Arg header +
 * octet-stream body). The Paper import endpoints live on api.dropboxapi.com —
 * unlike /files/upload — which also avoids the proxy's unreliable _domain
 * routing for content.dropboxapi.com (see downloadRequest).
 * Body goes via a temp file (--data-binary) to preserve bytes exactly.
 */
DropboxClient.prototype.paperRequest = function(endpoint, apiArg, content) {
  var os = require('os');
  var tmpFile = path.join(os.tmpdir(), 'dropbox-paper-' + process.pid + '-' + Date.now() + '.body');
  // 0600 + 'wx': not world-readable, and fail rather than follow a
  // pre-planted symlink at the predictable name.
  fs.writeFileSync(tmpFile, content, { mode: 384, flag: 'wx' });
  var response;
  try {
    response = this.authenticatedRequest(this.apiUrl + endpoint, {
      method: 'POST',
      headers: {
        'Dropbox-API-Arg': httpHeaderSafeJson(apiArg),
        'Content-Type': 'application/octet-stream'
      },
      bodyFile: tmpFile,
      timeout: this.timeout
    });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
  }

  var text = response.text();
  var data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { error: text };
  }

  if (!response.ok) {
    var err = new Error(data.error_summary || safeGet(data, 'error.message', null) || text || 'Paper request failed');
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
};

/**
 * Get shared link for a file
 */
DropboxClient.prototype.getSharedLink = function(filePath) {
  try {
    var existing = this.request('/sharing/list_shared_links', {
      path: filePath,
      direct_only: true
    });
    
    if (existing.links && existing.links.length > 0) {
      return existing.links[0];
    }
    
    return this.request('/sharing/create_shared_link_with_settings', {
      path: filePath,
      settings: {
        requested_visibility: 'public'
      }
    });
  } catch (error) {
    var sharedLink = safeGet(error, 'data.error.shared_link_already_exists.metadata', null);
    if (sharedLink) {
      return sharedLink;
    }
    throw error;
  }
};

// Format file size
function formatSize(bytes) {
  if (!bytes) return '0 B';
  var units = ['B', 'KB', 'MB', 'GB'];
  var i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes = bytes / 1024;
    i++;
  }
  return (i > 0 ? bytes.toFixed(1) : bytes.toFixed(0)) + ' ' + units[i];
}

// Print folder listing summary
function printFolderSummary(result) {
  var entries = result.entries || [];
  
  if (entries.length === 0) {
    console.log('Folder is empty.');
    return;
  }
  
  console.log('Found ' + entries.length + ' items:\n');
  
  var folders = [];
  var files = [];
  for (var i = 0; i < entries.length; i++) {
    if (entries[i]['.tag'] === 'folder') {
      folders.push(entries[i]);
    } else {
      files.push(entries[i]);
    }
  }
  
  for (var j = 0; j < folders.length; j++) {
    console.log('[DIR]  ' + folders[j].name + '/');
  }
  
  for (var k = 0; k < files.length; k++) {
    var file = files[k];
    var size = formatSize(file.size);
    var modified = file.client_modified ? new Date(file.client_modified).toLocaleDateString() : '';
    console.log('[FILE] ' + file.name + ' (' + size + ') ' + modified);
  }
  
  if (result.has_more) {
    console.log('\n... more items available (use --limit to increase)');
  }
}

// Print search results summary
function printSearchSummary(result, query) {
  var matches = result.matches || [];
  
  if (matches.length === 0) {
    console.log('No results found for "' + query + '".');
    return;
  }
  
  console.log('Found ' + matches.length + ' result(s) for "' + query + '":\n');
  
  for (var i = 0; i < matches.length; i++) {
    var match = matches[i];
    var metadata = safeGet(match, 'metadata.metadata', null) || match.metadata;
    if (!metadata) continue;
    
    var tag = metadata['.tag'];
    var filePath = metadata.path_display || metadata.name;
    
    if (tag === 'folder') {
      console.log('[DIR]  ' + filePath);
    } else {
      var size = formatSize(metadata.size);
      console.log('[FILE] ' + filePath + ' (' + size + ')');
    }
  }
  
  if (result.has_more) {
    console.log('\n... more results available');
  }
}

// Print Paper docs summary
function printPaperDocsSummary(result) {
  var matches = result.matches || [];
  
  if (matches.length === 0) {
    console.log('No Paper documents found.');
    return;
  }
  
  console.log('Found ' + matches.length + ' Paper document(s):\n');
  
  for (var i = 0; i < matches.length; i++) {
    var match = matches[i];
    var metadata = safeGet(match, 'metadata.metadata', null) || match.metadata;
    if (!metadata) continue;
    
    var filePath = metadata.path_display || metadata.name;
    var modified = metadata.client_modified ? new Date(metadata.client_modified).toLocaleDateString() : '';
    console.log(filePath + ' (' + modified + ')');
  }
}

// Print help
function printHelp() {
  console.log('');
  console.log('Dropbox Skill - Access files, folders, and Paper documents');
  console.log('');
  console.log('USAGE:');
  console.log('  dropbox <command> [options]');
  console.log('');
  console.log('COMMANDS:');
  console.log('  account                     Get current account info');
  console.log('  ls [path]                   List folder contents');
  console.log('  search <query>              Search files and folders');
  console.log('  paper [path]                List Paper documents');
  console.log('  paper-search <query>        Search Paper documents');
  console.log('  read <path>                 Read Paper document content');
  console.log('  paper-create <path>         Create a new Paper document');
  console.log('  paper-update <path>         Update an existing Paper document');
  console.log('  info <path>                 Get file/folder metadata');
  console.log('  link <path>                 Get or create shared link');
  console.log('  download <path>             Download a file');
  console.log('');
  console.log('OPTIONS:');
  console.log('  --summary                   Human-readable output');
  console.log('  --json                      Raw JSON output');
  console.log('  -r, --recursive             List recursively');
  console.log('  -n, --limit <number>        Maximum results (default: 100)');
  console.log('  -p, --path <path>           Limit search to a specific path');
  console.log('  -e, --ext <extensions>      Filter by file extensions');
  console.log('  -f, --format <format>       read: export format (markdown|html); paper-create/update: import format (markdown|html|plain_text)');
  console.log('  -c, --content <text>        Document content (inline, single-line only)');
  console.log('  -i, --input <file>          Read content from a local file (recommended for multi-line)');
  console.log('  --stdin                     Read content from stdin (recommended for multi-line)');
  console.log('  --policy <policy>           Update policy: update or overwrite');
  console.log('  -o, --output <file>         Save downloaded file to disk');
  console.log('');
  console.log('EXAMPLES:');
  console.log('  dropbox account --summary');
  console.log('  dropbox ls --summary');
  console.log('  dropbox ls "/CnR" --summary');
  console.log('  dropbox search "MTR" --summary');
  console.log('  dropbox read "/CnR/Notes.paper"');
  console.log('  dropbox paper-create "/Notes/New.paper" --content "Single line only"');
  console.log('  dropbox paper-create "/Notes/New.paper" --input content.md');
  console.log('  echo "# Multi-line\\nContent" | dropbox paper-create "/Notes/New.paper" --stdin');
  console.log('  dropbox link "/file.pdf"');
  console.log('');
}

// Main execution function

// ── PAVE Auth Proxy (replaces deprecated authenticatedFetch global) ──
// Direct HTTP calls to the PAVE auth proxy at /proxy/:tokenName/*path
var PAVE_PROXY_BASE = process.env.PAVE_PROXY_URL || '';

function _shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function proxyHasToken(tokenName) {
  if (!PAVE_PROXY_BASE) return false;
  try {
    var url = PAVE_PROXY_BASE.replace(/\/$/, '') + '/_tokens/' + encodeURIComponent(tokenName);
    var out = require('child_process').execSync(
      'curl -sS --max-time 5 ' + _shellQuote(url),
      { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    var r = JSON.parse(out);
    return r.has === true;
  } catch (e) {
    return false;
  }
}

function proxyFetch(tokenName, url, options) {
  options = options || {};
  if (!PAVE_PROXY_BASE) {
    throw new Error('PAVE_PROXY_URL not set - cannot reach auth proxy');
  }

  var parsed = new URL(url);
  var proxyUrl = PAVE_PROXY_BASE.replace(/\/$/, '') + '/' + encodeURIComponent(tokenName) + parsed.pathname + parsed.search;
  proxyUrl += (proxyUrl.indexOf('?') !== -1 ? '&' : '?') + '_mode=json';

  // Route to alternate domain when the URL hostname differs from the token's default domain
  // This is required for content endpoints (e.g. content.dropboxapi.com for /files/download)
  var defaultDomains = { dropbox: 'api.dropboxapi.com' };
  var tokenDefault = defaultDomains[tokenName];
  if (tokenDefault && parsed.hostname && parsed.hostname !== tokenDefault) {
    proxyUrl += '&_domain=' + encodeURIComponent(parsed.hostname);
  }

  if (options.saveTo) {
    proxyUrl += '&_saveTo=' + encodeURIComponent(options.saveTo);
  }

  var method = options.method || 'GET';
  var timeout = options.timeout || 30000;
  var cmd = 'curl -sS -X ' + method + ' --max-time ' + Math.ceil(timeout / 1000);

  var headers = Object.assign({}, options.headers || {});
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  for (var k in headers) {
    cmd += ' -H ' + _shellQuote(k + ': ' + headers[k]);
  }

  if (options.bodyFile) {
    // --data-binary @file preserves the body byte-for-byte (curl -d strips
    // newlines when reading from a file) — used for Paper content uploads.
    cmd += ' --data-binary @' + _shellQuote(options.bodyFile);
  } else if (options.body) {
    var bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    cmd += ' -d ' + _shellQuote(bodyStr);
  }

  cmd += ' ' + _shellQuote(proxyUrl);

  var out;
  try {
    out = require('child_process').execSync(cmd, {
      encoding: 'utf8', timeout: timeout + 5000, maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    var stdout = err.stdout ? err.stdout.toString() : '';
    var stderr = err.stderr ? err.stderr.toString() : '';
    if (stdout) { out = stdout; } else {
      throw new Error('Proxy request failed: ' + (stderr.trim() || err.message));
    }
  }

  var resp;
  try { resp = JSON.parse(out); } catch (e) {
    return { ok: true, status: 200, headers: { get: function() { return null; } },
      text: function() { return out; }, json: function() { return JSON.parse(out || '{}'); } };
  }
  if (resp.error) throw new Error(resp.error);
  if (resp.savedTo) {
    return { ok: resp.ok || false, status: resp.status || 200, savedTo: resp.savedTo,
      headers: { get: function() { return null; } },
      text: function() { return ''; }, json: function() { return {}; } };
  }
  return { ok: resp.ok || false, status: resp.status || 200,
    headers: { get: function(name) { var hs = resp.headers || {}, ln = name.toLowerCase();
      for (var key in hs) { if (key.toLowerCase() === ln) return Array.isArray(hs[key]) ? hs[key][0] : hs[key]; }
      return null; } },
    text: function() { return resp.body || ''; }, json: function() { return JSON.parse(resp.body || '{}'); } };
}

function main() {
  var parsed = parseArgs();
  
  if (!parsed.command || parsed.command === 'help' || parsed.options.help || parsed.options.h) {
    printHelp();
    return;
  }
  
  try {
    var client = new DropboxClient();
    var result;
    
    switch (parsed.command) {
      case 'account':
        result = client.getCurrentAccount();
        
        if (parsed.options.summary) {
          console.log('Account: ' + safeGet(result, 'name.display_name', 'Unknown'));
          console.log('Email: ' + (result.email || 'Unknown'));
          console.log('Account ID: ' + (result.account_id || 'Unknown'));
          console.log('Country: ' + (result.country || 'Unknown'));
          if (result.team) {
            console.log('Team: ' + (result.team.name || 'Unknown'));
          }
        } else {
          console.log(JSON.stringify(result));
        }
        break;
      
      case 'ls':
        var folderPath = parsed.positional[0] || '';
        var lsOptions = {
          recursive: parsed.options.recursive || parsed.options.r || false,
          limit: parseInt(parsed.options.limit || parsed.options.n, 10) || 100
        };
        
        result = client.listFolder(folderPath, lsOptions);
        
        if (parsed.options.summary) {
          printFolderSummary(result);
        } else {
          console.log(JSON.stringify(result));
        }
        break;
      
      case 'search':
        var searchQuery = parsed.positional[0];
        if (!searchQuery) {
          console.error('Error: Search query required');
          console.error('Usage: dropbox search <query>');
          process.exit(1);
        }
        
        var searchOptions = {
          maxResults: parseInt(parsed.options.max || parsed.options.n, 10) || 20
        };
        
        if (parsed.options.path || parsed.options.p) {
          searchOptions.path = parsed.options.path || parsed.options.p;
        }
        
        if (parsed.options.ext || parsed.options.e) {
          var extValue = parsed.options.ext || parsed.options.e;
          searchOptions.fileExtensions = extValue.split(',');
        }
        
        result = client.search(searchQuery, searchOptions);
        
        if (parsed.options.summary) {
          printSearchSummary(result, searchQuery);
        } else {
          console.log(JSON.stringify(result));
        }
        break;
      
      case 'paper':
        var paperFolder = parsed.positional[0] || '';
        result = client.listPaperDocs(paperFolder);
        
        if (parsed.options.summary) {
          printPaperDocsSummary(result);
        } else {
          console.log(JSON.stringify(result));
        }
        break;
      
      case 'paper-search':
        var paperQuery = parsed.positional[0];
        if (!paperQuery) {
          console.error('Error: Search query required');
          console.error('Usage: dropbox paper-search <query>');
          process.exit(1);
        }
        
        var paperSearchOptions = {
          maxResults: parseInt(parsed.options.max || parsed.options.n, 10) || 20
        };
        
        result = client.searchPaperDocs(paperQuery, paperSearchOptions);
        
        if (parsed.options.summary) {
          printSearchSummary(result, paperQuery);
        } else {
          console.log(JSON.stringify(result));
        }
        break;
      
      case 'read':
        var readPath = parsed.positional[0];
        if (!readPath) {
          console.error('Error: Paper doc path required');
          console.error('Usage: dropbox read <path>');
          process.exit(1);
        }
        
        var readFormat = parsed.options.format || parsed.options.f || 'markdown';
        var content = client.getPaperDocContent(readPath, readFormat);
        console.log(content);
        break;
      
      case 'paper-create':
        var createPath = parsed.positional[0];
        if (!createPath) {
          console.error('Error: Paper doc path required');
          process.exit(1);
        }
        
        var createContent;
        if (parsed.options.input || parsed.options.i) {
          var inputFile = parsed.options.input || parsed.options.i;
          createContent = fs.readFileSync(inputFile, 'utf-8');
        } else if (parsed.options.stdin) {
          // Read from stdin (sandbox-compatible approach)
          try {
            // In sandbox, we can read stdin as a file
            createContent = fs.readFileSync('/dev/stdin', 'utf-8').trim();
          } catch (e) {
            console.error('Error: Failed to read from stdin');
            console.error('Make sure to pipe content: echo "content" | dropbox ...');
            process.exit(1);
          }
          if (!createContent) {
            console.error('Error: No content received from stdin');
            process.exit(1);
          }
        } else if (parsed.options.content || parsed.options.c) {
          createContent = parsed.options.content || parsed.options.c;
        } else {
          console.error('Error: Content is required. Use one of:');
          console.error('  --content "text"     Inline content (single line only)');
          console.error('  --input file.md      Read from file (recommended for multi-line)');
          console.error('  --stdin              Read from stdin (recommended for multi-line)');
          console.error('');
          console.error('For multi-line content, use --input or --stdin to avoid parameter parsing issues.');
          process.exit(1);
        }
        
        var createFormat = parsed.options.format || parsed.options.f || 'markdown';
        result = client.createPaperDoc(createPath, createContent, createFormat);

        if (parsed.options.summary) {
          console.log('Created: ' + (result.result_path || createPath) + (result.url ? ' (' + result.url + ')' : ''));
        } else {
          console.log(JSON.stringify(result));
        }
        break;
      
      case 'paper-update':
        var updatePath = parsed.positional[0];
        if (!updatePath) {
          console.error('Error: Paper doc path required');
          process.exit(1);
        }
        
        var updateContent;
        if (parsed.options.input || parsed.options.i) {
          var updateInputFile = parsed.options.input || parsed.options.i;
          updateContent = fs.readFileSync(updateInputFile, 'utf-8');
        } else if (parsed.options.stdin) {
          // Read from stdin (sandbox-compatible approach)
          try {
            // In sandbox, we can read stdin as a file
            updateContent = fs.readFileSync('/dev/stdin', 'utf-8').trim();
          } catch (e) {
            console.error('Error: Failed to read from stdin');
            console.error('Make sure to pipe content: echo "content" | dropbox ...');
            process.exit(1);
          }
          if (!updateContent) {
            console.error('Error: No content received from stdin');
            process.exit(1);
          }
        } else if (parsed.options.content || parsed.options.c) {
          updateContent = parsed.options.content || parsed.options.c;
        } else {
          console.error('Error: Content is required. Use one of:');
          console.error('  --content "text"     Inline content (single line only)');
          console.error('  --input file.md      Read from file (recommended for multi-line)');
          console.error('  --stdin              Read from stdin (recommended for multi-line)');
          console.error('');
          console.error('For multi-line content, use --input or --stdin to avoid parameter parsing issues.');
          process.exit(1);
        }
        
        var updateFormat = parsed.options.format || parsed.options.f || 'markdown';
        var updatePolicy = parsed.options.policy || 'overwrite';
        result = client.updatePaperDoc(updatePath, updateContent, updateFormat, updatePolicy);
        
        if (parsed.options.summary) {
          console.log('Updated: ' + updatePath + (result.paper_revision !== undefined ? ' (revision ' + result.paper_revision + ')' : ''));
        } else {
          console.log(JSON.stringify(result));
        }
        break;
      
      case 'info':
        var infoPath = parsed.positional[0];
        if (!infoPath) {
          console.error('Error: File path required');
          process.exit(1);
        }
        
        result = client.getMetadata(infoPath);
        
        if (parsed.options.summary) {
          console.log('Name: ' + result.name);
          console.log('Type: ' + result['.tag']);
          console.log('Path: ' + result.path_display);
          if (result.size !== undefined) {
            console.log('Size: ' + formatSize(result.size));
          }
          if (result.client_modified) {
            console.log('Modified: ' + new Date(result.client_modified).toLocaleString());
          }
          if (result.id) {
            console.log('ID: ' + result.id);
          }
        } else {
          console.log(JSON.stringify(result));
        }
        break;
      
      case 'link':
        var linkPath = parsed.positional[0];
        if (!linkPath) {
          console.error('Error: File path required');
          process.exit(1);
        }
        
        result = client.getSharedLink(linkPath);
        
        if (parsed.options.summary) {
          console.log('Shared link: ' + result.url);
        } else {
          console.log(result.url);
        }
        break;
      
      case 'download':
        var downloadPath = parsed.positional[0];
        if (!downloadPath) {
          console.error('Error: File path required');
          process.exit(1);
        }
        
        var outputFile = parsed.options.output || parsed.options.o;
        
        // Route .paper files through /files/export instead of /files/download
        if (downloadPath.toLowerCase().slice(-6) === '.paper') {
          if (outputFile) {
            var paperSavedTo = client.getPaperDocContent(downloadPath, 'markdown', outputFile);
            console.log('Saved to ' + paperSavedTo);
          } else {
            var paperContent = client.getPaperDocContent(downloadPath);
            console.log(paperContent);
          }
          break;
        }
        
        if (outputFile) {
          // Use proxy's _saveTo for efficient binary download
          var savedTo = client.downloadFile(downloadPath, outputFile);
          console.log('Saved to ' + savedTo);
        } else {
          var downloadContent = client.downloadFile(downloadPath);
          console.log(downloadContent);
        }
        break;
      
      case 'upload':
        var localFile = parsed.positional[0];
        var remotePath = parsed.positional[1];
        if (!localFile || !remotePath) {
          console.error('Error: Local file path and Dropbox destination path required');
          console.error('Usage: dropbox upload <localPath> <dropboxPath>');
          process.exit(1);
        }
        if (!fs.existsSync(localFile)) {
          console.error('Error: Local file not found: ' + localFile);
          process.exit(1);
        }
        var uploadMode = parsed.options.mode || 'overwrite';
        var uploadResult = client.uploadFile(localFile, remotePath, uploadMode);
        if (parsed.options.summary) {
          console.log('Uploaded to ' + uploadResult.path_display + ' (' + uploadResult.size + ' bytes)');
        } else {
          console.log('⬆️  Uploaded: ' + uploadResult.name);
          console.log('📂 Path: ' + uploadResult.path_display);
          console.log('📏 Size: ' + uploadResult.size + ' bytes');
          console.log('🆔 ID: ' + uploadResult.id);
        }
        break;
      
      default:
        console.error('Error: Unknown command "' + parsed.command + '"');
        console.error('\nRun: dropbox help');
        process.exit(1);
    }
    
  } catch (error) {
    if (parsed.options.summary) {
      console.error('Dropbox Error: ' + error.message);
    } else {
      console.error(JSON.stringify({
        error: error.message,
        status: error.status,
        data: error.data
      }));
    }
    process.exit(1);
  }
}

// Execute
main();
