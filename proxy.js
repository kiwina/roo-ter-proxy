// Simple logging proxy for OpenRouter API with full-message assembly

const express = require("express");
const morgan = require("morgan");
const fs = require("fs");
const path = require("path");
const https = require("https");

// Debug logging helper
const DEBUG = true;
function debug(msg, ...args) {
  if (DEBUG) console.log(`[DEBUG] ${msg}`, ...args);
}

// Make model name safe for file paths (Windows compatible)
function getSafeModelDirName(modelName) {
  if (!modelName) return "unknown-model";

  // Replace invalid Windows path characters with dashes
  return modelName.replace(/[<>:"/\\|?*]/g, "-");
}

// Define logs directory
const logsDir = path.join(__dirname, "logs");

// Create logs directory if needed
try {
  if (!fs.existsSync(logsDir)) {
    console.log(`[Init] Creating logs directory at: ${logsDir}`);
    fs.mkdirSync(logsDir, { recursive: true });
    console.log(`[Init] Logs directory created successfully`);
  } else {
    console.log(`[Init] Using existing logs directory at: ${logsDir}`);
  }

  // Verify write permissions
  const testFile = path.join(logsDir, "test_write.txt");
  fs.writeFileSync(testFile, "Write test");
  fs.unlinkSync(testFile);
  console.log(
    `[Init] Successfully verified write permissions to logs directory`
  );
} catch (error) {
  console.error(`[CRITICAL] Error with logs directory: ${error.message}`);
}

// Setup Express
const app = express();
const PORT = process.env.PORT || 3000;

// Log incoming requests
app.use((req, res, next) => {
  console.log(`[DEBUG] Incoming: ${req.method} ${req.originalUrl}`);
  next();
});

// HTTP request logging
app.use(morgan("combined"));

// Combined monitoring and proxy for OpenRouter API paths
app.use("/api/v1", (req, res) => {
  console.log(
    "[Monitor+Proxy] Request received, setting up monitoring and forwarding"
  );

  const requestId = Date.now();
  const responseStreamedChunks = [];
  let modelName = "unknown-model";
  let modelLogDir = logsDir;

  // Collect request body chunks
  const requestBodyChunks = [];
  req.on("data", (chunk) => {
    requestBodyChunks.push(chunk);
  });
  req.on("end", () => {
    // Initialize bodyBuffer outside the if block so it's available in the entire closure
    let bodyBuffer = Buffer.alloc(0);

    // Process request body to extract model info if available
    if (requestBodyChunks.length > 0) {
      bodyBuffer = Buffer.concat(requestBodyChunks);

      try {
        // Try to parse the body as JSON to extract model information
        const bodyText = bodyBuffer.toString("utf8");
        try {
          const bodyJson = JSON.parse(bodyText);
          if (bodyJson.model) {
            modelName = bodyJson.model;
            console.log(`[Monitor] Detected model: ${modelName}`);

            // Create safe directory name for the model
            const safeModelDir = getSafeModelDirName(modelName);
            modelLogDir = path.join(logsDir, safeModelDir);

            // Create model directory if it doesn't exist
            if (!fs.existsSync(modelLogDir)) {
              console.log(
                `[Monitor] Creating model directory at: ${modelLogDir}`
              );
              fs.mkdirSync(modelLogDir, { recursive: true });
            }
          }
        } catch (jsonErr) {
          console.log(
            `[Monitor] Could not parse request body as JSON: ${jsonErr.message}`
          );
        }
      } catch (err) {
        console.error(
          `[Monitor] Error processing request body: ${err.message}`
        );
      }

      // Save the request body
      const bodyFile = path.join(modelLogDir, `req_body_${requestId}.bin`);
      try {
        fs.writeFileSync(bodyFile, bodyBuffer);
        console.log(`[Monitor] Request body saved to ${bodyFile}`);
      } catch (err) {
        console.error(`[Monitor] Failed to save request body: ${err.message}`);
      }
    }

    // Log request headers
    const reqLogFile = path.join(modelLogDir, `req_${requestId}.log`);
    try {
      let headerLog = `${req.method} ${req.url} HTTP/${req.httpVersion}\n`;
      for (const [key, value] of Object.entries(req.headers)) {
        headerLog += `${key}: ${value}\n`;
      }
      fs.writeFileSync(reqLogFile, headerLog);
      console.log(`[Monitor] Request headers saved to ${reqLogFile}`);
    } catch (err) {
      console.error(`[Monitor] Failed to save request headers: ${err.message}`);
    }

    // Prepare proxy options
    const options = {
      hostname: "openrouter.ai",
      port: 443,
      path: `/api/v1${req.url}`,
      method: req.method,
      headers: {
        ...req.headers,
        host: "openrouter.ai",
      },
    };

    console.log(
      `[Proxy] Forwarding to: ${options.method} ${options.hostname}${options.path}`
    );

    // Create proxied request
    const proxyReq = https.request(options, (proxyRes) => {
      console.log(`[Proxy] Received response: ${proxyRes.statusCode}`);

      // Copy status and headers
      res.statusCode = proxyRes.statusCode;
      res.statusMessage = proxyRes.statusMessage;
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (key.toLowerCase() !== "connection") {
          res.setHeader(key, value);
        }
      }

      // Stream & accumulate response
      proxyRes.on("data", (chunk) => {
        res.write(chunk);
        responseStreamedChunks.push(chunk);
      });

      proxyRes.on("end", () => {
        res.end();

        // Assemble full message from JSON chunks
        try {
          const fullText = Buffer.concat(responseStreamedChunks).toString(
            "utf8"
          );
          const jsonPayloads = fullText
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .filter((line) => line && line !== "[DONE]");

          let completeMessage = "";
          for (const payload of jsonPayloads) {
            const obj = JSON.parse(payload);
            const delta = obj.choices?.[0]?.delta;
            if (delta?.content) {
              completeMessage += delta.content;
            }
          }

          const outPath = path.join(modelLogDir, `res_full_${requestId}.txt`);
          fs.writeFileSync(outPath, completeMessage, "utf8");
          console.log(
            `[Monitor] Complete assistant response saved to ${outPath}`
          );
        } catch (err) {
          console.error(
            `[Monitor] Failed to assemble full response: ${err.message}`
          );
        }
      });
    });

    // Handle proxy errors
    proxyReq.on("error", (err) => {
      console.error(`[Proxy] Error: ${err.message}`);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: "Proxy Error", message: err.message }));
      }
    });

    // Pipe request body if present
    if (req.method !== "GET" && req.method !== "HEAD") {
      // We've already consumed the body, so recreate it from the buffer
      proxyReq.write(bodyBuffer);
      proxyReq.end();
    } else {
      proxyReq.end();
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(
    `Proxy listening on http://localhost:${PORT}/api/v1/* → https://openrouter.ai/api/v1/*`
  );
});
