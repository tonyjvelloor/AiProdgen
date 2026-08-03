const nodemailer = require('nodemailer');

// Email configuration - uses environment variables
// For Gmail: Use App Password (not regular password)
// Get App Password: Google Account > Security > 2-Step Verification > App Passwords

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@aiproductgen.com';
const APP_NAME = 'AI ProductGen';

module.exports = {
    // Send login credentials after successful payment
    sendCredentialsEmail: async (email, password) => {
        if (!process.env.SMTP_USER) {
            console.log('SMTP not configured - skipping email');
            console.log(`Credentials for ${email}: Password: ${password}`);
            return false;
        }

        const mailOptions = {
            from: `"${APP_NAME}" <${FROM_EMAIL}>`,
            to: email,
            subject: `🎉 Welcome to ${APP_NAME} - Your Login Credentials`,
            html: `
                <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px;">
                            <h1 style="margin: 0; font-size: 28px;">Welcome to ${APP_NAME}!</h1>
                        </div>
                    </div>
                    
                    <p style="font-size: 16px; color: #333;">Thank you for your purchase! Your lifetime access is now active.</p>
                    
                    <div style="background: #f8f9fa; border-radius: 12px; padding: 24px; margin: 24px 0;">
                        <h3 style="margin-top: 0; color: #333;">Your Login Credentials</h3>
                        <p style="margin: 8px 0;"><strong>Email:</strong> ${email}</p>
                        <p style="margin: 8px 0;"><strong>Password:</strong> <code style="background: #e9ecef; padding: 4px 8px; border-radius: 4px;">${password}</code></p>
                    </div>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${process.env.APP_URL || 'http://localhost:3002'}/login.html" 
                           style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                                  color: white; 
                                  padding: 14px 32px; 
                                  text-decoration: none; 
                                  border-radius: 8px; 
                                  font-weight: bold;
                                  display: inline-block;">
                            Login to Your Account →
                        </a>
                    </div>
                    
                    <p style="font-size: 14px; color: #666;">
                        <strong>Tip:</strong> We recommend changing your password after your first login for security.
                    </p>
                    
                    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                    
                    <p style="font-size: 12px; color: #999; text-align: center;">
                        © 2025 ${APP_NAME}. All rights reserved.
                    </p>
                </div>
            `
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log(`Credentials email sent to ${email}`);
            return true;
        } catch (error) {
            console.error('Email send error:', error.message);
            return false;
        }
    },

    // Send password reset email
    sendPasswordResetEmail: async (email, resetToken, resetUrl) => {
        if (!process.env.SMTP_USER) {
            console.log('SMTP not configured - skipping email');
            console.log(`Reset link for ${email}: ${resetUrl}`);
            return false;
        }

        const mailOptions = {
            from: `"${APP_NAME}" <${FROM_EMAIL}>`,
            to: email,
            subject: `🔐 Password Reset - ${APP_NAME}`,
            html: `
                <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px;">
                            <h1 style="margin: 0; font-size: 24px;">Password Reset Request</h1>
                        </div>
                    </div>
                    
                    <p style="font-size: 16px; color: #333;">
                        We received a request to reset your password. Click the button below to create a new password.
                    </p>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${resetUrl}" 
                           style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                                  color: white; 
                                  padding: 14px 32px; 
                                  text-decoration: none; 
                                  border-radius: 8px; 
                                  font-weight: bold;
                                  display: inline-block;">
                            Reset My Password
                        </a>
                    </div>
                    
                    <p style="font-size: 14px; color: #666;">
                        This link will expire in 1 hour. If you didn't request this, please ignore this email.
                    </p>
                    
                    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                    
                    <p style="font-size: 12px; color: #999; text-align: center;">
                        © 2025 ${APP_NAME}. All rights reserved.
                    </p>
                </div>
            `
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log(`Password reset email sent to ${email}`);
            return true;
        } catch (error) {
            console.error('Email send error:', error.message);
            return false;
        }
    }
};
