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

// Global map tracker to pair open client requests with incoming webhooks
const pendingRequests = new Map();

// Target your active APPSeCONNECT Webhook Listener route
const APPSE_WEBHOOK_URL = process.env.APPSE_WEBHOOK_URL;
/**
 * Endpoint 1: Fired by your Netlify Frontend Form
 */
app.post('/api/generate', async (req, res) => {
    const { target_email, topic, verification_key, submit_date } = req.body;
    
    // Generate a unique transaction ID for this student's generation run
    const transactionId = `tx_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    
    console.log(`[Client Request] Initiating Transaction: ${transactionId} for ${target_email}`);
    
    // Store the Express response object in our map to hold the connection open
    pendingRequests.set(transactionId, res);
    
    // Build the payload payload to route forward down the canvas pipeline
    const appsePayload = {
        transaction_id: transactionId, // Crucial: Sent forward so the HTTP node can return it
        verification_key,
        topic,
        target_email,
        submit_date
    };
    
    try {
        // Fire and forget to APPSeCONNECT so the background canvas engine wakes up
        await axios.post(APPSE_WEBHOOK_URL, appsePayload);
        console.log(`[Appse Sent] Payload successfully dispatched for ${transactionId}`);
    } catch (error) {
        console.error(`[Appse Error] Failed to trigger webhook gateway:`, error.message);
        // Clear the map tracking pointer if the webhook fails upfront
        pendingRequests.delete(transactionId);
        return res.status(500).json({ error: "Failed to initialize automation gateway pipeline." });
    }
    
    // Set a safety backend timeout handler. If the canvas takes over 2 minutes, release the connection safely
    setTimeout(() => {
        if (pendingRequests.has(transactionId)) {
            console.log(`[Timeout] Transaction ${transactionId} exceeded runtime boundary.`);
            const clientResponse = pendingRequests.get(transactionId);
            clientResponse.status(504).json({ error: "Gateway transaction timed out. Check your Gmail inbox!" });
            pendingRequests.delete(transactionId);
        }
    }, 120000); 
});

/**
 * Endpoint 2: Fired by the HTTP Response Node at the very end of your Canvas Flow
 */
app.post('/api/receive-file', (req, res) => {
    // Expects the exact JSON mapping configuration from your canvas node parameters
    const { transaction_id, report_data } = req.body;
    
    console.log(`[Incoming File Webhook] Received file stream data payload for transaction: ${transaction_id}`);
    
    // Check if we have an open frontend browser connection matching this transaction
    if (pendingRequests.has(transaction_id)) {
        const clientResponse = pendingRequests.get(transaction_id);
        
        // Push the Base64 payload and filename directly back to the waiting frontend!
        clientResponse.status(200).json({
            success: true,
            report_data: {
                file_name: report_data.file_name,
                content_type: report_data.content_type,
                base64_data: report_data.base64_data
            }
        });
        
        // Remove the transaction pointer from active tracking memory
        pendingRequests.delete(transaction_id);
        console.log(`[Transaction Resolved] Successfully sent file package back to Netlify Client UI.`);
        
        return res.status(200).json({ status: "Success client response delivered." });
    } else {
        console.warn(`[Orphaned Payload] Transaction ${transaction_id} not found in memory map or already timed out.`);
        return res.status(404).json({ error: "No matching active client connection context found." });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Proxy Relay Server operational and running on port ${PORT}`);
});