// lib/email.js


// Send emails using Resend (or mock if not configured)
// Whether a real transport is configured. Exported so /api/health can report
// it: with no provider, signup succeeds, no verification mail is sent, and the
// user is left permanently unverified -- which blocks generation behind
// requireVerifiedUser. That is worth surfacing rather than discovering.
const isEmailConfigured = () => !!(process.env.RESEND_API_KEY || (process.env.SMTP_HOST && process.env.SMTP_USER));

async function sendEmail(to, subject, html) {
    if (!process.env.RESEND_API_KEY) {
        // Returning true here makes the caller believe the mail went out. Keep
        // that behaviour so local development works, but in production say
        // plainly that nothing was delivered.
        const line = `[EMAIL NOT SENT — no provider configured] To: ${to} | Subject: ${subject}`;
        if (process.env.NODE_ENV === 'production') {
            console.error(line + ' — set RESEND_API_KEY so verification and password reset can work.');
        } else {
            console.log(`[EMAIL MOCK] To: ${to} | Subject: ${subject}`);
            console.log(`[EMAIL MOCK] Body: ${html}`);
        }
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
    isEmailConfigured,
    sendEmail,
    sendVerificationEmail,
    sendPasswordResetEmail
};
