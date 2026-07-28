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
 * Convert markdown to HTML suitable for Dropbox Paper API import.
 * 
 * The Dropbox Paper API's markdown parser is limited - it collapses
 * blank lines between paragraphs and merges numbered list content.
 * Converting to HTML with explicit <p> tags and &nbsp; spacers
 * preserves the intended formatting.
 */
function markdownToDropboxHtml(md) {
  var lines = md.split('\n');
  var html = [];
  var inList = false;
  var i = 0;
  
  while (i < lines.length) {
    var line = lines[i];
    var trimmed = line.replace(/^\s+/, '');
    
    // Empty line - add spacer paragraph
    if (trimmed === '') {
      // Don't add spacer at very beginning or end
      if (html.length > 0 && i < lines.length - 1) {
        html.push('<p>&nbsp;</p>');
      }
      i++;
      continue;
    }
    
    // Heading lines: # ## ### etc
    var headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      var level = headingMatch[1].length;
      html.push('<h' + level + '>' + escapeHtml(headingMatch[2]) + '</h' + level + '>');
      i++;
      continue;
    }
    
    // Image: ![alt](url)
    var imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      html.push('<p><img src="' + escapeHtml(imgMatch[2]) + '" alt="' + escapeHtml(imgMatch[1]) + '" /></p>');
      i++;
      continue;
    }
    
    // Horizontal rule: --- or ***  or ___
    if (trimmed.match(/^[-*_]{3,}$/)) {
      html.push('<hr />');
      i++;
      continue;
    }

    // Markdown table:
    //   | h1 | h2 |
    //   |----|----|
    //   | a  | b  |
    if (trimmed.charAt(0) === '|' && i + 1 < lines.length) {
      var sepLine = lines[i + 1].replace(/^\s+/, '');
      var sepRe = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
      if (sepRe.test(sepLine)) {
        var splitRow = function(row) {
          var s = row.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
          return s.split('|').map(function(c) { return c.replace(/^\s+|\s+$/g, ''); });
        };
        var renderCell = function(text) {
          var t = escapeHtml(text);
          t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
          t = t.replace(/\*([^*]+)\*/g, '<i>$1</i>');
          t = t.replace(/__([^_]+)__/g, '<b>$1</b>');
          t = t.replace(/_([^_]+)_/g, '<i>$1</i>');
          return t;
        };
        var headers = splitRow(trimmed);
        i += 2; // skip header + separator
        var rows = [];
        while (i < lines.length) {
          var rowLine = lines[i].replace(/^\s+/, '');
          if (rowLine.charAt(0) !== '|') break;
          rows.push(splitRow(rowLine));
          i++;
        }
        // Emit Dropbox Paper "native" editable table markup.
        // Key structure (reverse-engineered from existing Paper docs):
        //   <div style="width:100%;overflow:auto;">
        //     <table style="width:100%;border-spacing:0;border:1px solid #c1c7cd;word-break:break-word;">
        //       <tbody>
        //         <tr>
        //           <td style="...per-side border widths...">
        //             <div dir="auto" style="line-height:26px;" class="ace-line "><span>cell</span></div>
        //           </td>
        //         </tr>
        //       </tbody>
        //     </table>
        //   </div>
        // Border rules: first row TD top=0; all TDs bottom=0, right=0; first col TD left=0, others left=1;
        // non-first row TDs top=1.
        var tdStyle = function(rowIdx, colIdx) {
          var top = rowIdx === 0 ? 0 : 1;
          var left = colIdx === 0 ? 0 : 1;
          return 'border-color: #c1c7cd;border-style: solid;'
            + 'border-top-width: ' + top + ';'
            + 'border-bottom-width: 0;'
            + 'border-right-width: 0;'
            + 'border-left-width: ' + left + ';'
            + 'min-width: 50px;min-height: 20px;padding: 5px 8px;'
            + 'word-break: normal;vertical-align: top;';
        };
        var wrapCell = function(text) {
          return '<div dir="auto" style="line-height: 26px;" class="ace-line "><span>'
            + renderCell(text) + '</span></div>';
        };
        var allRows = [headers].concat(rows);
        var tbl = ['<div style="width: 100%; overflow: auto;">'];
        tbl.push('<table style="width: 100%;border-spacing: 0;border: 1px solid #c1c7cd;word-break: break-word;">');
        tbl.push('<tbody>');
        for (var rr = 0; rr < allRows.length; rr++) {
          tbl.push('<tr>');
          for (var cc = 0; cc < allRows[rr].length; cc++) {
            // Bold the entire header row
            var cellText = allRows[rr][cc];
            if (rr === 0 && cellText.length > 0) cellText = '**' + cellText.replace(/\*\*/g, '') + '**';
            tbl.push('<td style="' + tdStyle(rr, cc) + '">' + wrapCell(cellText) + '</td>');
          }
          tbl.push('</tr>');
        }
        tbl.push('</tbody></table></div>');
        html.push(tbl.join(''));
        continue;
      }
    }
    
    // Ordered list item: "1. Text" or "    1. Text" (sub-item)
    var olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (olMatch) {
      var indent = olMatch[1].length;
      var text = olMatch[3];
      // Main list items (no indent) - render as bold numbered paragraph
      // Sub-list items (indented) - render with indent
      if (indent >= 4) {
        // Sub-item under a list item - indent with nbsp
        var indentStr = '';
        for (var s = 0; s < indent; s++) indentStr += '&nbsp;';
        html.push('<p>' + indentStr + olMatch[2] + '. ' + escapeHtml(text) + '</p>');
      } else {
        html.push('<p>' + olMatch[2] + '. ' + escapeHtml(text) + '</p>');
      }
      i++;
      continue;
    }
    
    // Unordered list item: "- Text" or "* Text"
    var ulMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (ulMatch) {
      var ulIndent = ulMatch[1].length;
      var ulText = ulMatch[2];
      var ulIndentStr = '';
      for (var u = 0; u < ulIndent; u++) ulIndentStr += '&nbsp;';
      html.push('<p>' + ulIndentStr + '- ' + escapeHtml(ulText) + '</p>');
      i++;
      continue;
    }
    
    // Indented content (4+ spaces) - preserve indentation with nbsp
    var indentedMatch = line.match(/^(\s{4,})(.*)$/);
    if (indentedMatch) {
      var spaces = indentedMatch[1].length;
      var indentContent = indentedMatch[2];
      var nbspIndent = '';
      for (var n = 0; n < spaces; n++) nbspIndent += '&nbsp;';
      html.push('<p>' + nbspIndent + escapeHtml(indentContent) + '</p>');
      i++;
      continue;
    }
    
    // Bold text: **text**
    // Regular paragraph
    var paragraphText = escapeHtml(trimmed);
    // Process inline formatting
    paragraphText = paragraphText.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    paragraphText = paragraphText.replace(/\*([^*]+)\*/g, '<i>$1</i>');
    paragraphText = paragraphText.replace(/__([^_]+)__/g, '<b>$1</b>');
    paragraphText = paragraphText.replace(/_([^_]+)_/g, '<i>$1</i>');
    
    // Preserve leading whitespace for non-indented but spaced lines
    var leadingSpaces = line.match(/^(\s*)/)[1].length;
    if (leadingSpaces > 0 && leadingSpaces < 4) {
      var spaceStr = '';
      for (var sp = 0; sp < leadingSpaces; sp++) spaceStr += '&nbsp;';
      html.push('<p>' + spaceStr + paragraphText + '</p>');
    } else {
      html.push('<p>' + paragraphText + '</p>');
    }
    i++;
  }
  
  return html.join('\n');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
      'Dropbox-API-Arg': JSON.stringify(apiArg),
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
      'Dropbox-API-Arg': JSON.stringify(apiArg),
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
 * Note: Creating Paper docs in shared folders may fail with invalid_file_extension
 * In that case, we create at root and move to the target location
 * 
 * When import_format is 'markdown', we auto-convert to HTML to work around
 * the Dropbox Paper API's limited markdown parser (which collapses blank lines
 * and merges numbered list content).
 */
DropboxClient.prototype.createPaperDoc = function(docPath, content, importFormat) {
  var actualContent = content;
  var actualFormat = importFormat || 'markdown';
  if (actualFormat === 'markdown') {
    actualContent = markdownToDropboxHtml(content);
    actualFormat = 'html';
  }

  // Use /files/upload on content.dropboxapi.com instead of the broken
  // /files/paper/create on api.dropboxapi.com (which returns 500).
  // The .paper extension in the path tells Dropbox to treat it as a Paper doc.
  try {
    return this.uploadRequest('/files/upload', {
      path: docPath,
      mode: 'add',
      autorename: true,
      mute: false
    }, actualContent);
  } catch (err) {
    if (err.data && err.data.error && err.data.error['.tag'] === 'invalid_file_extension') {
      var parts = docPath.split('/');
      var filename = parts[parts.length - 1];
      var tempPath = '/' + filename;
      var result = this.uploadRequest('/files/upload', {
        path: tempPath,
        mode: 'add',
        autorename: true,
        mute: false
      }, actualContent);
      var actualPath = result.path_display || tempPath;
      if (actualPath !== docPath) {
        var moveResult = this.request('/files/move_v2', {
          from_path: actualPath,
          to_path: docPath,
          allow_shared_folder: true,
          autorename: false
        });
        result.path_display = moveResult.metadata.path_display;
      }
      return result;
    }
    throw err;
  }
};

/**
 * Update an existing Paper document
 * For 'update' policy (append), we need to provide the current paper_revision
 * 
 * When import_format is 'markdown', we auto-convert to HTML to work around
 * the Dropbox Paper API's limited markdown parser.
 */
DropboxClient.prototype.updatePaperDoc = function(docPath, content, importFormat, updatePolicy) {
  var actualContent = content;
  var actualFormat = importFormat || 'markdown';
  if (actualFormat === 'markdown') {
    actualContent = markdownToDropboxHtml(content);
    actualFormat = 'html';
  }

  // Use /files/upload on content.dropboxapi.com instead of the broken
  // /files/paper/update on api.dropboxapi.com (which returns 500).
  // mode:'overwrite' replaces the content; mode:'add' would create a new revision.
  var mode = (updatePolicy === 'overwrite' || !updatePolicy) ? 'overwrite' : 'add';
  return this.uploadRequest('/files/upload', {
    path: docPath,
    mode: mode,
    autorename: false,
    mute: false
  }, actualContent);
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
  console.log('  -f, --format <format>       Export format: markdown or html');
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

  if (options.body) {
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
          console.log('Created: ' + (result.path_display || createPath));
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
          console.log('Updated: ' + (result.path_display || updatePath));
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
