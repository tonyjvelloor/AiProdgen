// lib/email.js
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Send emails using Resend (or mock if not configured)
async function sendEmail(to, subject, html) {
    if (!process.env.RESEND_API_KEY) {
        console.log(`[EMAIL MOCK] To: ${to} | Subject: ${subject}`);
        console.log(`[EMAIL MOCK] Body: ${html}`);
        return true;
    }

    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: process.env.EMAIL_FROM || 'AIProdGen <noreply@aiprodgen.com>',
                to: [to],
                subject: subject,
                html: html
            })
        });
        
        if (!response.ok) {
            console.error('❌ Failed to send email via Resend:', await response.text());
            return false;
        }
        
        return true;
    } catch (error) {
        console.error('❌ Error sending email:', error.message);
        return false;
    }
}

async function sendVerificationEmail(email, token) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const verifyUrl = `${appUrl}/api/auth/verify-email?token=${token}`;
    
    return sendEmail(
        email, 
        'Verify your AIProdGen Account', 
        `<p>Welcome to AIProdGen!</p><p>Please verify your email by clicking the link below:</p><a href="${verifyUrl}">${verifyUrl}</a>`
    );
}

async function sendPasswordResetEmail(email, token) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const resetUrl = `${appUrl}/reset-password.html?token=${token}`; // Assuming you have a reset-password.html
    
    return sendEmail(
        email, 
        'Reset your AIProdGen Password', 
        `<p>You requested a password reset.</p><p>Click the link below to reset your password:</p><a href="${resetUrl}">${resetUrl}</a><p>If you didn't request this, ignore this email.</p>`
    );
}

module.exports = {
    sendEmail,
    sendVerificationEmail,
    sendPasswordResetEmail
};
