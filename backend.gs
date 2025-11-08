/**
 * README - API de pendientes para Gmail y reuniones
 *
 * Descripción general:
 *   Web App de Google Apps Script que expone endpoints REST mínimos para analizar
 *   correos recientes de Gmail y notas de reuniones (Docs) asociadas a eventos
 *   de Google Calendar usando OpenAI Chat Completions.
 *
 * Configuración inicial:
 *   1. Abra el editor de Apps Script y cree un nuevo proyecto.
 *   2. Pegue este archivo completo en el editor (reemplazando el código existente).
 *   3. En App Script, vaya a "Project Settings" → "Script properties" y añada:
 *        - OPENAI_API_KEY: clave de la API de OpenAI.
 *        - (Opcional) DEFAULT_EMAIL_HOURS, DEFAULT_MEET_HOURS, OPENAI_MODEL.
 *   4. En "Services" habilite las APIs avanzadas necesarias:
 *        - Gmail API
 *        - Calendar API
 *        - Drive API
 *   5. En "Project Settings" → "Scopes" revise y acepte los siguientes mínimos:
 *        - https://www.googleapis.com/auth/gmail.readonly
 *        - https://www.googleapis.com/auth/calendar.readonly
 *        - https://www.googleapis.com/auth/drive.readonly
 *   6. Despliegue como Web App: "Deploy" → "New deployment" → "Web App".
 *        - Execute as: User accessing the web app.
 *        - Who has access: Anyone with the link (o el alcance deseado).
 *   7. Autorice los scopes cuando se solicite.
 *
 * Pruebas rápidas con curl (reemplace {SCRIPT_URL} por la URL de despliegue):
 *   curl -s {SCRIPT_URL}/health
 *   curl -s -X POST {SCRIPT_URL}/scan-email \
 *        -H 'Content-Type: application/json' \
 *        -d '{"hours":6,"maxThreads":5}'
 *   curl -s -X POST {SCRIPT_URL}/scan-meet \
 *        -H 'Content-Type: application/json' \
 *        -d '{"hours":12,"maxEvents":5}'
 *
 * Ejemplo de respuesta /scan-email:
 * {
 *   "status":"ok",
 *   "source":"email",
 *   "items":[
 *     {
 *       "mail_id":"1832f...",
 *       "from":"cliente@example.com",
 *       "subject":"Seguimiento propuesta",
 *       "priority":"alta",
 *       "summary":"Cliente solicita revisión del presupuesto enviado.",
 *       "action_items":[{"title":"Revisar presupuesto","description":"Actualizar costos","due_date":null}],
 *       "received_at":"2024-05-01T14:23:00.000Z"
 *     }
 *   ],
 *   "skipped_count":0
 * }
 *
 * Ejemplo de respuesta /scan-meet:
 * {
 *   "status":"ok",
 *   "source":"meet",
 *   "items":[
 *     {
 *       "event_id":"abc123",
 *       "event_title":"Weekly sync",
 *       "meeting_summary":"Se revisaron avances y bloqueos principales...",
 *       "decisions":["Aprobar sprint backlog"],
 *       "action_items":[{"title":"Actualizar tablero","description":"Reflejar acuerdos","due_date":null,"priority":"media"}],
 *       "start":"2024-05-01T13:00:00.000Z",
 *       "end":"2024-05-01T13:30:00.000Z",
 *       "doc_url":"https://docs.google.com/document/d/..."
 *     }
 *   ],
 *   "skipped_count":0
 * }
 *
 * Limitaciones y ampliaciones:
 *   - Este backend es stateless; sólo usa CacheService (10-15 min) para reducir costos.
 *   - No persiste datos sensibles; los textos se envían a OpenAI y se descartan.
 *   - Para análisis más profundos puede integrarse con base de datos o Google Sheets.
 *   - Ajuste OPENAI_MODEL y parámetros en callOpenAI según necesidades.
 */

/**
 * Punto de entrada GET para la Web App.
 * @param {GoogleAppsScript.Events.DoGet} e
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function doGet(e) {
  var method = 'GET';
  if (e && e.parameter && e.parameter._method) {
    method = String(e.parameter._method).toUpperCase();
  }
  return handleRequest_(method, e || {});
}

/**
 * Punto de entrada POST para la Web App.
 * @param {GoogleAppsScript.Events.DoPost} e
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  var method = 'POST';
  if (e && e.parameter && e.parameter._method) {
    method = String(e.parameter._method).toUpperCase();
  } else if (e && e.postData && !e.postData.contents) {
    method = 'OPTIONS';
  }
  return handleRequest_(method, e || {});
}

/**
 * Maneja rutas comunes para GET/POST/OPTIONS.
 * @param {string} method
 * @param {Object} e
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function handleRequest_(method, e) {
  var pathInfo = (e && e.pathInfo) ? String(e.pathInfo).replace(/^\//, '') : '';
  var lowerMethod = method.toUpperCase();

  if (lowerMethod === 'GET' && (!pathInfo || pathInfo === 'health')) {
    return buildJsonResponse_(200, {
      status: 'ok',
      ok: true,
      ts: new Date().toISOString()
    });
  }

  if (lowerMethod === 'OPTIONS') {
    return buildJsonResponse_(200, {status: 'ok'});
  }

  if (lowerMethod === 'POST') {
    var path = pathInfo;
    var payload = {};
    try {
      if (e && e.postData && e.postData.contents) {
        payload = JSON.parse(e.postData.contents || '{}');
      }
    } catch (err) {
      return buildJsonResponse_(400, {
        status: 'error',
        message: 'JSON inválido en la petición',
        hint: 'Asegúrate de enviar Content-Type: application/json',
        details: err.message
      });
    }

    if (path === 'scan-email') {
      return handleScanEmail_(payload);
    }
    if (path === 'scan-meet') {
      return handleScanMeet_(payload);
    }
  }

  return buildJsonResponse_(404, {
    status: 'error',
    message: 'Ruta no encontrada',
    hint: 'Usa /health, /scan-email o /scan-meet'
  });
}

/**
 * Construye la respuesta JSON con cabeceras CORS.
 * @param {number} statusCode (informativo; Apps Script siempre devuelve 200)
 * @param {Object} payload
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function buildJsonResponse_(statusCode, payload) {
  var textOutput = ContentService.createTextOutput(JSON.stringify(payload || {}));
  textOutput.setMimeType(ContentService.MimeType.JSON);
  textOutput.setHeader('Access-Control-Allow-Origin', '*');
  textOutput.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  textOutput.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  textOutput.setHeader('X-Status-Code', String(statusCode || 200));
  return textOutput;
}

/**
 * Maneja POST /scan-email.
 * @param {Object} params
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function handleScanEmail_(params) {
  var config;
  try {
    config = getScriptConfig_();
  } catch (err) {
    return buildJsonResponse_(500, {
      status: 'error',
      message: 'Configuración incompleta',
      hint: 'Define OPENAI_API_KEY en Script Properties',
      details: err.message
    });
  }

  var userEmail = (Session.getActiveUser() && Session.getActiveUser().getEmail()) || 'anon';
  var hours = Math.max(1, parseInt(params.hours || config.defaultEmailHours, 10));
  var maxThreads = Math.max(1, Math.min(50, parseInt(params.maxThreads || 20, 10)));
  var query = 'newer_than:' + hours + 'h';
  var excludeCategories = Array.isArray(params.excludeCategories) ? params.excludeCategories : [];
  excludeCategories.forEach(function (cat) {
    query += ' -category:' + cat;
  });
  if (params.query) {
    query += ' ' + params.query;
  }

  var cacheKey = ['scan-email', userEmail, hours, maxThreads, excludeCategories.join(','), params.query || ''].join(':');
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);
  if (cached) {
    return buildJsonResponse_(200, JSON.parse(cached));
  }

  var items = [];
  var skipped = 0;
  try {
    var threads = Gmail.Users.Threads.list('me', {
      q: query,
      maxResults: maxThreads
    });

    if (!threads || !threads.threads) {
      return finalizeEmailResponse_(cache, cacheKey, items, skipped);
    }

    threads.threads.forEach(function (thread) {
      try {
        var threadDetail = Gmail.Users.Threads.get('me', thread.id, {format: 'full'});
        if (!threadDetail || !threadDetail.messages || !threadDetail.messages.length) {
          skipped++;
          return;
        }
        var message = threadDetail.messages[0];
        var headers = extractHeaders_(message.payload && message.payload.headers);
        var bodyText = truncateText_(extractPlainBody_(message.payload) || '', 7000);
        var prompt = buildEmailPrompt_(headers.subject, headers.from, headers.date, bodyText);
        var aiResponse = callOpenAI_(prompt, {
          model: config.openAiModel,
          maxTokens: 400,
          temperature: 0.2,
          apiKey: config.apiKey
        });
        var parsed;
        try {
          parsed = JSON.parse(aiResponse);
        } catch (jsonErr) {
          skipped++;
          return;
        }
        if (!parsed || parsed.requires_attention !== true) {
          return;
        }
        items.push({
          mail_id: message.id,
          from: headers.from || '',
          subject: headers.subject || '',
          priority: parsed.priority || null,
          summary: parsed.summary || '',
          action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
          received_at: message.internalDate ? new Date(parseInt(message.internalDate, 10)).toISOString() : null
        });
      } catch (innerErr) {
        skipped++;
      }
    });
  } catch (err) {
    return buildJsonResponse_(500, {
      status: 'error',
      message: 'No se pudo consultar Gmail',
      hint: 'Verifica los scopes y habilita el servicio avanzado de Gmail',
      details: err.message
    });
  }

  return finalizeEmailResponse_(cache, cacheKey, items, skipped);
}

/**
 * Guarda en caché y responde la salida de /scan-email.
 * @param {GoogleAppsScript.Cache.Cache} cache
 * @param {string} key
 * @param {Array} items
 * @param {number} skipped
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function finalizeEmailResponse_(cache, key, items, skipped) {
  var response = {
    status: 'ok',
    source: 'email',
    items: items,
    skipped_count: skipped
  };
  cache.put(key, JSON.stringify(response), 600);
  return buildJsonResponse_(200, response);
}

/**
 * Maneja POST /scan-meet.
 * @param {Object} params
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function handleScanMeet_(params) {
  var config;
  try {
    config = getScriptConfig_();
  } catch (err) {
    return buildJsonResponse_(500, {
      status: 'error',
      message: 'Configuración incompleta',
      hint: 'Define OPENAI_API_KEY en Script Properties',
      details: err.message
    });
  }

  var userEmail = (Session.getActiveUser() && Session.getActiveUser().getEmail()) || 'anon';
  var hours = Math.max(1, parseInt(params.hours || config.defaultMeetHours, 10));
  var maxEvents = Math.max(1, Math.min(25, parseInt(params.maxEvents || 10, 10)));

  var cacheKey = ['scan-meet', userEmail, hours, maxEvents].join(':');
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);
  if (cached) {
    return buildJsonResponse_(200, JSON.parse(cached));
  }

  var now = new Date();
  var timeMin = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
  var timeMax = now.toISOString();
  var items = [];
  var skipped = 0;

  try {
    var events = Calendar.Events.list('primary', {
      timeMin: timeMin,
      timeMax: timeMax,
      maxResults: maxEvents,
      singleEvents: true,
      orderBy: 'startTime',
      supportsAttachments: true
    });

    if (!events || !events.items) {
      return finalizeMeetResponse_(cache, cacheKey, items, skipped);
    }

    events.items.forEach(function (event) {
      if (!event || !(event.hangoutLink || (event.conferenceData && event.conferenceData.entryPoints && event.conferenceData.entryPoints.length))) {
        return;
      }

      var docFile = pickLatestDocAttachment_(event.attachments);
      if (!docFile) {
        skipped++;
        return;
      }

      try {
        var docText = truncateText_(fetchDocumentText_(docFile.fileId), 8000);
        if (!docText) {
          skipped++;
          return;
        }
        var prompt = buildMeetPrompt_(docText);
        var aiResponse = callOpenAI_(prompt, {
          model: config.openAiModel,
          maxTokens: 500,
          temperature: 0.2,
          apiKey: config.apiKey
        });
        var parsed;
        try {
          parsed = JSON.parse(aiResponse);
        } catch (jsonErr) {
          skipped++;
          return;
        }
        items.push({
          event_id: event.id,
          event_title: event.summary || '',
          meeting_summary: parsed.summary || '',
          decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
          action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
          start: event.start && (event.start.dateTime || event.start.date) ? new Date(event.start.dateTime || event.start.date).toISOString() : null,
          end: event.end && (event.end.dateTime || event.end.date) ? new Date(event.end.dateTime || event.end.date).toISOString() : null,
          doc_url: docFile.alternateLink || ('https://docs.google.com/document/d/' + docFile.fileId)
        });
      } catch (innerErr) {
        skipped++;
      }
    });
  } catch (err) {
    return buildJsonResponse_(500, {
      status: 'error',
      message: 'No se pudo consultar Calendar o Drive',
      hint: 'Verifica los scopes y habilita los servicios avanzados de Calendar y Drive',
      details: err.message
    });
  }

  return finalizeMeetResponse_(cache, cacheKey, items, skipped);
}

/**
 * Guarda en caché y responde la salida de /scan-meet.
 * @param {GoogleAppsScript.Cache.Cache} cache
 * @param {string} key
 * @param {Array} items
 * @param {number} skipped
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function finalizeMeetResponse_(cache, key, items, skipped) {
  var response = {
    status: 'ok',
    source: 'meet',
    items: items,
    skipped_count: skipped
  };
  cache.put(key, JSON.stringify(response), 600);
  return buildJsonResponse_(200, response);
}

/**
 * Lee propiedades de configuración del Script.
 * @returns {{apiKey:string, defaultEmailHours:number, defaultMeetHours:number, openAiModel:string}}
 */
function getScriptConfig_() {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('OPENAI_API_KEY');
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no definido');
  }
  return {
    apiKey: apiKey,
    defaultEmailHours: parseInt(props.getProperty('DEFAULT_EMAIL_HOURS') || '6', 10),
    defaultMeetHours: parseInt(props.getProperty('DEFAULT_MEET_HOURS') || '24', 10),
    openAiModel: props.getProperty('OPENAI_MODEL') || 'gpt-4o-mini'
  };
}

/**
 * Construye el prompt para correos.
 * @param {string} subject
 * @param {string} from
 * @param {string} date
 * @param {string} body
 * @returns {string}
 */
function buildEmailPrompt_(subject, from, date, body) {
  return (
    'Eres un asistente que SOLO devuelve JSON válido.\n' +
    'Tu tarea: decidir si el correo requiere atención y extraer acciones.\n\n' +
    'Formato de salida:\n' +
    '{\n' +
    '  "requires_attention": true|false,\n' +
    '  "priority": "alta|media|baja|null",\n' +
    '  "summary": "máx 200 caracteres",\n' +
    '  "action_items": [\n' +
    '    {"title":"verbo + objeto", "description":"contexto breve", "due_date":"YYYY-MM-DD|null"}\n' +
    '  ]\n' +
    '}\n\n' +
    'Reglas:\n' +
    '- Si es promo/FYI → requires_attention=false.\n' +
    '- No inventes fechas (usa null).\n' +
    '- Sin texto fuera del JSON.\n\n' +
    'Correo:\n' +
    'Asunto: ' + (subject || '') + '\n' +
    'Remitente: ' + (from || '') + '\n' +
    'Fecha: ' + (date || '') + '\n' +
    'Cuerpo:\n' +
    (body || '')
  );
}

/**
 * Construye el prompt para notas de reuniones.
 * @param {string} docText
 * @returns {string}
 */
function buildMeetPrompt_(docText) {
  return (
    'Eres un extractor que SOLO devuelve JSON válido.\n\n' +
    'Salida:\n' +
    '{\n' +
    '  "summary": "máx 6 frases",\n' +
    '  "decisions": ["..."],\n' +
    '  "action_items": [\n' +
    '    {"title":"verbo + objeto", "description":"contexto", "due_date":"YYYY-MM-DD|null", "priority":"alta|media|baja"}\n' +
    '  ]\n' +
    '}\n\n' +
    'Reglas:\n' +
    '- No inventes fechas; usa null si no se dijo.\n' +
    '- Sin texto fuera del JSON.\n\n' +
    'Texto de notas de reunión:\n' +
    (docText || '')
  );
}

/**
 * Extrae cabeceras clave.
 * @param {Array} headersArray
 * @returns {{from:string,subject:string,date:string}}
 */
function extractHeaders_(headersArray) {
  var result = {from: '', subject: '', date: ''};
  if (!headersArray) {
    return result;
  }
  headersArray.forEach(function (header) {
    var name = header.name || header.Name;
    var value = header.value || header.Value;
    if (!name) {
      return;
    }
    name = name.toLowerCase();
    if (name === 'from') {
      result.from = value;
    } else if (name === 'subject') {
      result.subject = value;
    } else if (name === 'date') {
      result.date = value;
    }
  });
  return result;
}

/**
 * Extrae el cuerpo plano de un mensaje de Gmail.
 * @param {Object} payload
 * @returns {string}
 */
function extractPlainBody_(payload) {
  if (!payload) {
    return '';
  }
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return decodeBase64UrlSafe_(payload.body.data);
  }
  if (payload.parts && payload.parts.length) {
    for (var i = 0; i < payload.parts.length; i++) {
      var part = payload.parts[i];
      var text = extractPlainBody_(part);
      if (text) {
        return text;
      }
    }
  }
  if (payload.body && payload.body.data) {
    return decodeBase64UrlSafe_(payload.body.data);
  }
  return '';
}

/**
 * Decodifica base64 URL-safe.
 * @param {string} data
 * @returns {string}
 */
function decodeBase64UrlSafe_(data) {
  if (!data) {
    return '';
  }
  var normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  var pad = normalized.length % 4;
  if (pad) {
    normalized += '===='.slice(pad);
  }
  return Utilities.newBlob(Utilities.base64Decode(normalized)).getDataAsString();
}

/**
 * Recorta texto para limitar tamaño enviado a OpenAI.
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
function truncateText_(text, maxLength) {
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + '\n...[recortado]';
}

/**
 * Invoca la API de OpenAI Chat Completions.
 * @param {string} prompt
 * @param {{model:string, maxTokens:number, temperature:number, apiKey:string}} options
 * @returns {string}
 */
function callOpenAI_(prompt, options) {
  if (!options || !options.apiKey) {
    throw new Error('Falta OPENAI_API_KEY');
  }
  var payload = {
    model: options.model || 'gpt-4o-mini',
    messages: [
      {role: 'user', content: prompt}
    ],
    max_tokens: options.maxTokens || 500,
    temperature: typeof options.temperature === 'number' ? options.temperature : 0.2
  };
  var response = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + options.apiKey,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true,
    payload: JSON.stringify(payload)
  });
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code >= 400) {
    throw new Error('OpenAI error ' + code + ': ' + body);
  }
  var data = JSON.parse(body);
  if (!data || !data.choices || !data.choices.length) {
    throw new Error('Respuesta inválida de OpenAI');
  }
  return data.choices[0].message.content;
}

/**
 * Selecciona el adjunto Doc más reciente del evento.
 * @param {Array} attachments
 * @returns {?{fileId:string, alternateLink:string}}
 */
function pickLatestDocAttachment_(attachments) {
  if (!attachments || !attachments.length) {
    return null;
  }
  var docs = attachments.filter(function (att) {
    return att && att.fileId && att.mimeType && att.mimeType.indexOf('application/vnd.google-apps.document') === 0;
  });
  if (!docs.length) {
    return null;
  }
  var best = null;
  var bestTime = 0;
  docs.forEach(function (doc) {
    try {
      var meta = Drive.Files.get(doc.fileId, {fields: 'modifiedTime,alternateLink'});
      var time = meta && meta.modifiedTime ? new Date(meta.modifiedTime).getTime() : 0;
      if (!best || time > bestTime) {
        best = {
          fileId: doc.fileId,
          alternateLink: (meta && meta.alternateLink) || doc.alternateLink || doc.fileUrl || ''
        };
        bestTime = time;
      }
    } catch (err) {
      // Ignorar y continuar con el siguiente adjunto.
    }
  });
  if (best) {
    return best;
  }
  return {
    fileId: docs[0].fileId,
    alternateLink: docs[0].alternateLink || docs[0].fileUrl || ''
  };
}

/**
 * Descarga el texto de un Google Doc.
 * @param {string} fileId
 * @returns {string}
 */
function fetchDocumentText_(fileId) {
  if (!fileId) {
    return '';
  }
  var url = 'https://docs.google.com/document/d/' + encodeURIComponent(fileId) + '/export?format=txt';
  var response = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
    },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() >= 400) {
    throw new Error('No se pudo leer el Doc: ' + response.getContentText());
  }
  return response.getContentText();
}

