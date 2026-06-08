const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for your Netlify domain dashboard
app.use(cors({
    origin: '*', // For development. Replace with your actual Netlify URL in production
    methods: ['GET', 'POST', 'OPTIONS']
}));

// Increase payload parsing limits to handle the massive Base64 document strings smoothly
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Global map tracker to pair open client requests with incoming webhooks (Strict Mode)
const pendingRequests = new Map();

// Global variable placeholder fallback if the transaction_id comes back blank or empty ""
let lastActiveClientResponse = null;

// Target your active APPSeCONNECT Webhook Listener route
const APPSE_WEBHOOK_URL = process.env.APPSE_WEBHOOK_URL;

/**
 * Endpoint 1: Fired by your Netlify Frontend Form
 */
app.post('/api/generate', async (req, res) => {
    // Capture the transaction_id straight from the frontend form payload
    const { transaction_id, target_email, topic, verification_key, submit_date } = req.body;

    console.log(`[Client Request] Received Frontend Transaction ID: "${transaction_id}" for ${target_email}`);

    // 1. Store the Express response object using the frontend token if it exists
    if (transaction_id && transaction_id.trim() !== "") {
        pendingRequests.set(transaction_id, res);
    }

    // 2. Always track it as the last active client response placeholder in case the ID drops down the line
    lastActiveClientResponse = res;

    try {
        // Forward the exact payload (including the transaction_id) to APPSeCONNECT
        await axios.post(APPSE_WEBHOOK_URL, req.body);
        console.log(`[Appse Sent] Payload successfully dispatched for ${transaction_id}`);
    } catch (error) {
        console.error(`[Appse Error] Failed to trigger webhook gateway:`, error.message);
        if (transaction_id) pendingRequests.delete(transaction_id);
        if (lastActiveClientResponse === res) lastActiveClientResponse = null;
        return res.status(500).json({ error: "Failed to initialize automation gateway pipeline." });
    }

    // Safety 2-minute connection release timeout
    setTimeout(() => {
        if (transaction_id && pendingRequests.has(transaction_id)) {
            console.log(`[Timeout] Transaction ${transaction_id} exceeded runtime boundary.`);
            const clientResponse = pendingRequests.get(transaction_id);
            clientResponse.status(504).json({ error: "Gateway transaction timed out. Check your Gmail inbox!" });
            pendingRequests.delete(transaction_id);
        }
        if (lastActiveClientResponse === res) {
            lastActiveClientResponse = null;
        }
    }, 120000);
});

/**
 * Endpoint 2: Fired by the HTTP Response Node at the very end of your Canvas Flow
 */
app.post('/api/receive-file', (req, res) => {
    // Expects the JSON mapping configuration from your canvas node parameters
    const { transaction_id, report_data } = req.body;

    console.log(`[Incoming File Webhook] Received file stream data payload for transaction: "${transaction_id}"`);

    let targetResponseObject = null;
    let matchMethod = "";

    // PATH A: Check if we have an open frontend browser connection matching this transaction strictly
    if (transaction_id && pendingRequests.has(transaction_id)) {
        targetResponseObject = pendingRequests.get(transaction_id);
        matchMethod = "Strict Token Match";
        pendingRequests.delete(transaction_id);
    } 
    // PATH B: Fallback loop if the incoming transaction_id is blank, null, or empty string ""
    else if (!transaction_id || transaction_id.trim() === "") {
        if (lastActiveClientResponse) {
            targetResponseObject = lastActiveClientResponse;
            matchMethod = "Blank Token Fallback Loop";
            lastActiveClientResponse = null;
        }
    }

    // If a connection was located via either path, push the file and discharge the request
    if (targetResponseObject) {
        console.log(`[Transaction Resolved] Successfully sent file package back to Netlify Client UI via [${matchMethod}].`);

        targetResponseObject.status(200).json({
            success: true,
            report_data: {
                file_name: report_data?.file_name || "AI_Research_Dossier.html",
                content_type: report_data?.content_type || "text/html",
                base64_data: report_data?.base64_data
            }
        });

        return res.status(200).json({ status: `Success client response delivered via ${matchMethod}.` });
    } else {
        console.warn(`[Orphaned Payload] Transaction "${transaction_id}" not found in memory map or already timed out.`);
        return res.status(404).json({ error: "No matching active client connection context found." });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Proxy Relay Server operational and running on port ${PORT}`);
});