const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");
const { PDFParse } = require("pdf-parse");
const OpenAI = require("openai");
const crypto = require("crypto");

require("dotenv").config();

const app = express();
const port = Number(process.env.PORT) || 3000;


// ======================================================
// PATHS / DATA DIRECTORY
// ======================================================

const dataDir = path.join(__dirname, "data");

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "database.sqlite");


// ======================================================
// DATABASE
// ======================================================

const db = new sqlite3.Database(dbPath, (error) => {

    if (error) {
        console.error("❌ Database connection failed:", error);
        process.exit(1);
    }

    console.log("✅ SQLite database connected");
});


// Create users table
db.run(
    `
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    `,
    (error) => {

        if (error) {
            console.error("❌ Users table error:", error);
            process.exit(1);
        }

        console.log("✅ Users table ready");
    }
);
// ======================================================
// GENERATION HISTORY
// ======================================================

db.run(
    `
    CREATE TABLE IF NOT EXISTS generations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        tool TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
    `,
    (error) => {
        if (error) {
            console.error("❌ Generations table error:", error);
        } else {
            console.log("✅ Generations table ready");
        }
    }
);
// ======================================================
// PASSWORD RESET TOKENS TABLE
// ======================================================

db.run(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at DATETIME NOT NULL,
        used INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
`, (error) => {

    if (error) {
        console.error(
            "❌ Password reset table error:",
            error
        );
    } else {
        console.log(
            "✅ Password reset tokens table ready"
        );
    }

});

// ======================================================
// OPENAI
// ======================================================

let openaiClient = null;

const envKey = String(
    process.env.OPENAI_API_KEY || ""
).trim();

const isPlaceholderKey =
    !envKey ||
    envKey.includes("YAHAN") ||
    envKey.includes("YOUR_") ||
    envKey.includes("PASTE") ||
    envKey.includes("REAL_OPENAI") ||
    envKey.length < 20;

if (!isPlaceholderKey) {

    openaiClient = new OpenAI({
        apiKey: envKey
    });

    console.log("✅ OpenAI client enabled");

} else {

    console.log(
        "ℹ️ OpenAI key not configured — demo AI mode enabled"
    );
}


// ======================================================
// FILE UPLOAD
// ======================================================

const upload = multer({

    storage: multer.memoryStorage(),

    limits: {
        fileSize: 10 * 1024 * 1024
    },

    fileFilter: (req, file, callback) => {

        if (file.mimetype === "application/pdf") {
            callback(null, true);
        } else {
            callback(
                new Error("Only PDF files are allowed.")
            );
        }

    }
});


// ======================================================
// MIDDLEWARE
// ======================================================

app.use(
    cors({
        origin: true,
        credentials: true
    })
);

app.use(express.json());

app.use(
    express.urlencoded({
        extended: true
    })
);


// ======================================================
// SESSION
// ======================================================

app.use(
    session({

        store: new SQLiteStore({
            db: "sessions.sqlite",
            dir: dataDir
        }),

        secret:
            process.env.SESSION_SECRET ||
            "ai-toolbox-development-secret",

        resave: false,

        saveUninitialized: false,

        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure:
                process.env.NODE_ENV === "production",
            maxAge:
                7 * 24 * 60 * 60 * 1000
        }

    })
);
// ======================================================
// HELPERS
// ======================================================

function normalizeEmail(email) {

    return String(email || "")
        .trim()
        .toLowerCase();

}


function requireLogin(req, res, next) {

    if (!req.session.userId) {

        return res.redirect("/login.html");

    }

    next();

}


function saveGeneration(userId, tool) {

    if (!userId) return;

    db.run(
        `
        INSERT INTO generations (user_id, tool)
        VALUES (?, ?)
        `,
        [userId, tool],
        (error) => {

            if (error) {

                console.error(
                    "❌ Generation save error:",
                    error
                );

            }

        }
    );

}


// ======================================================
// PROTECTED PAGES
// IMPORTANT: These routes come BEFORE express.static()
// ======================================================

app.get(
    "/dashboard.html",
    requireLogin,
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                "..",
                "dashboard.html"
            )
        );

    }
);


app.get(
    "/profile.html",
    requireLogin,
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                "..",
                "profile.html"
            )
        );

    }
);


// ======================================================
// SERVE FRONTEND
// ======================================================

app.use(
    express.static(
        path.join(__dirname, "..")
    )
);


// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/api/health", (req, res) => {

    res.json({
        ok: true,
        server: "AI Toolbox",
        database: "SQLite",
        ai:
            openaiClient
                ? "enabled"
                : "demo"
    });

});


// ======================================================
// SIGNUP
// ======================================================

app.post(
    "/api/auth/signup",
    async (req, res) => {

        try {

            const {
                name,
                email,
                password
            } = req.body;

            const cleanName =
                String(name || "").trim();

            const cleanEmail =
                normalizeEmail(email);

            const cleanPassword =
                String(password || "");


            if (
                !cleanName ||
                !cleanEmail ||
                !cleanPassword
            ) {

                return res.status(400).json({
                    error:
                        "Name, email and password are required."
                });

            }


            if (cleanName.length < 2) {

                return res.status(400).json({
                    error:
                        "Name must be at least 2 characters."
                });

            }


            if (cleanName.length > 50) {

                return res.status(400).json({
                    error:
                        "Name must be 50 characters or less."
                });

            }


            if (cleanPassword.length < 6) {

                return res.status(400).json({
                    error:
                        "Password must be at least 6 characters."
                });

            }


            const emailPattern =
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


            if (!emailPattern.test(cleanEmail)) {

                return res.status(400).json({
                    error:
                        "Please enter a valid email address."
                });

            }


            const passwordHash =
                await bcrypt.hash(
                    cleanPassword,
                    12
                );


            db.run(
                `
                INSERT INTO users
                (name, email, password_hash)
                VALUES (?, ?, ?)
                `,
                [
                    cleanName,
                    cleanEmail,
                    passwordHash
                ],
                function (error) {

                    if (error) {

                        if (
                            error.message.includes(
                                "UNIQUE constraint failed"
                            )
                        ) {

                            return res.status(409).json({
                                error:
                                    "An account with this email already exists."
                            });

                        }


                        console.error(
                            "❌ Signup database error:",
                            error
                        );


                        return res.status(500).json({
                            error:
                                "Could not create account."
                        });

                    }


                    return res.status(201).json({

                        message:
                            "Account created successfully.",

                        user: {
                            id: this.lastID,
                            name: cleanName,
                            email: cleanEmail
                        }

                    });

                }
            );

        } catch (error) {

            console.error(
                "❌ Signup error:",
                error
            );


            res.status(500).json({
                error:
                    "Signup failed."
            });

        }

    }
);


// ======================================================
// LOGIN
// ======================================================

app.post(
    "/api/auth/login",
    (req, res) => {

        const {
            email,
            password
        } = req.body;

        const cleanEmail =
            normalizeEmail(email);

        const cleanPassword =
            String(password || "");


        if (
            !cleanEmail ||
            !cleanPassword
        ) {

            return res.status(400).json({
                error:
                    "Email and password are required."
            });

        }


        db.get(
            `
            SELECT
                id,
                name,
                email,
                password_hash
            FROM users
            WHERE email = ?
            `,
            [cleanEmail],
            async (error, user) => {

                if (error) {

                    console.error(
                        "❌ Login database error:",
                        error
                    );


                    return res.status(500).json({
                        error:
                            "Login failed."
                    });

                }


                if (!user) {

                    return res.status(401).json({
                        error:
                            "Invalid email or password."
                    });

                }


                try {

                    const validPassword =
                        await bcrypt.compare(
                            cleanPassword,
                            user.password_hash
                        );


                    if (!validPassword) {

                        return res.status(401).json({
                            error:
                                "Invalid email or password."
                        });

                    }


                    req.session.userId =
                        user.id;


                    req.session.save(
                        (saveError) => {

                            if (saveError) {

                                console.error(
                                    "❌ Session save error:",
                                    saveError
                                );


                                return res.status(500).json({
                                    error:
                                        "Could not create login session."
                                });

                            }


                            return res.json({

                                message:
                                    "Login successful.",

                                user: {
                                    id: user.id,
                                    name: user.name,
                                    email: user.email
                                }

                            });

                        }
                    );

                } catch (error) {

                    console.error(
                        "❌ Password verification error:",
                        error
                    );


                    return res.status(500).json({
                        error:
                            "Login failed."
                    });

                }

            }
        );

    }
);


// ======================================================
// CURRENT USER
// ======================================================

app.get(
    "/api/auth/me",
    (req, res) => {

        if (!req.session.userId) {

            return res.status(401).json({
                error:
                    "Not logged in."
            });

        }


        db.get(
            `
            SELECT
                id,
                name,
                email,
                created_at
            FROM users
            WHERE id = ?
            `,
            [req.session.userId],
            (error, user) => {

                if (error) {

                    console.error(
                        "❌ User lookup error:",
                        error
                    );


                    return res.status(500).json({
                        error:
                            "Could not load user."
                    });

                }


                if (!user) {

                    req.session.destroy(
                        () => {}
                    );


                    return res.status(401).json({
                        error:
                            "User account not found."
                    });

                }


                res.json({
                    user
                });

            }
        );

    }
);


// ======================================================
// UPDATE PROFILE
// ======================================================

app.put(
    "/api/auth/profile",
    (req, res) => {

        if (!req.session.userId) {

            return res.status(401).json({
                error:
                    "Not logged in."
            });

        }


        const name =
            String(req.body.name || "")
                .trim();


        if (!name) {

            return res.status(400).json({
                error:
                    "Name is required."
            });

        }


        if (name.length < 2) {

            return res.status(400).json({
                error:
                    "Name must be at least 2 characters."
            });

        }


        if (name.length > 50) {

            return res.status(400).json({
                error:
                    "Name must be 50 characters or less."
            });

        }


        db.run(
            `
            UPDATE users
            SET name = ?
            WHERE id = ?
            `,
            [
                name,
                req.session.userId
            ],
            function (error) {

                if (error) {

                    console.error(
                        "❌ Profile update error:",
                        error
                    );


                    return res.status(500).json({
                        error:
                            "Could not update profile."
                    });

                }


                if (this.changes === 0) {

                    return res.status(404).json({
                        error:
                            "User not found."
                    });

                }


                res.json({

                    message:
                        "Profile updated successfully.",

                    name: name

                });

            }
        );

    }
);
// ======================================================
// CHANGE PASSWORD
// ======================================================

app.put("/api/auth/change-password", async (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            error: "Not logged in."
        });
    }

    const currentPassword = String(
        req.body.currentPassword || ""
    );

    const newPassword = String(
        req.body.newPassword || ""
    );

    if (!currentPassword || !newPassword) {
        return res.status(400).json({
            error: "Current password and new password are required."
        });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({
            error: "New password must be at least 6 characters."
        });
    }

    db.get(
        `
        SELECT id, password_hash
        FROM users
        WHERE id = ?
        `,
        [req.session.userId],
        async (error, user) => {

            if (error) {
                console.error("❌ Password lookup error:", error);

                return res.status(500).json({
                    error: "Could not change password."
                });
            }

            if (!user) {
                return res.status(404).json({
                    error: "User account not found."
                });
            }

            try {

                const validPassword = await bcrypt.compare(
                    currentPassword,
                    user.password_hash
                );

                if (!validPassword) {
                    return res.status(401).json({
                        error: "Current password is incorrect."
                    });
                }

                const newPasswordHash = await bcrypt.hash(
                    newPassword,
                    12
                );

                db.run(
                    `
                    UPDATE users
                    SET password_hash = ?
                    WHERE id = ?
                    `,
                    [
                        newPasswordHash,
                        req.session.userId
                    ],
                    function (updateError) {

                        if (updateError) {
                            console.error(
                                "❌ Password update error:",
                                updateError
                            );

                            return res.status(500).json({
                                error: "Could not update password."
                            });
                        }

                        return res.json({
                            message: "Password changed successfully."
                        });
                    }
                );

            } catch (passwordError) {

                console.error(
                    "❌ Password processing error:",
                    passwordError
                );

                return res.status(500).json({
                    error: "Could not change password."
                });
            }
        }
    );
});
// ======================================================
// FORGOT PASSWORD
// ======================================================

app.post("/api/auth/forgot-password", (req, res) => {

    const email = normalizeEmail(req.body.email);

    if (!email) {
        return res.status(400).json({
            error: "Email address is required."
        });
    }

    db.get(
        `
        SELECT id, name, email
        FROM users
        WHERE email = ?
        `,
        [email],
        (error, user) => {

            if (error) {
                console.error(
                    "❌ Forgot password lookup error:",
                    error
                );

                return res.status(500).json({
                    error:
                        "Could not process password reset."
                });
            }

            // Security: same response for existing/non-existing email
            if (!user) {
                return res.json({
                    message:
                        "If an account exists with this email, a reset link has been prepared."
                });
            }

            // Create secure random token
            const token =
                crypto.randomBytes(32).toString("hex");

            // Token valid for 15 minutes
            const expiresAt =
                new Date(
                    Date.now() + 15 * 60 * 1000
                ).toISOString();

            // Remove previous unused tokens
            db.run(
                `
                DELETE FROM password_reset_tokens
                WHERE user_id = ?
                AND used = 0
                `,
                [user.id],
                (deleteError) => {

                    if (deleteError) {
                        console.error(
                            "❌ Old reset token cleanup error:",
                            deleteError
                        );
                    }

                    // Save new token
                    db.run(
                        `
                        INSERT INTO password_reset_tokens
                        (user_id, token, expires_at)
                        VALUES (?, ?, ?)
                        `,
                        [
                            user.id,
                            token,
                            expiresAt
                        ],
                        (insertError) => {

                            if (insertError) {

                                console.error(
                                    "❌ Reset token insert error:",
                                    insertError
                                );

                                return res.status(500).json({
                                    error:
                                        "Could not create reset link."
                                });
                            }

                            const resetLink =
                                `http://localhost:3000/reset-password.html?token=${token}`;

                            console.log("");
                            console.log(
                                "=========================================="
                            );
                            console.log(
                                "🔐 PASSWORD RESET LINK"
                            );
                            console.log(resetLink);
                            console.log(
                                "⏰ Expires in 15 minutes"
                            );
                            console.log(
                                "=========================================="
                            );
                            console.log("");

                            return res.json({
                                message:
                                    "If an account exists with this email, a reset link has been prepared."
                            });

                        }
                    );
                }
            );
        }
    );
});

// ======================================================
// LOGOUT
// ======================================================

app.post(
    "/api/auth/logout",
    (req, res) => {

        req.session.destroy(
            (error) => {

                if (error) {

                    console.error(
                        "❌ Logout error:",
                        error
                    );


                    return res.status(500).json({
                        error:
                            "Logout failed."
                    });

                }


                res.clearCookie(
                    "connect.sid"
                );


                res.json({
                    message:
                        "Logged out successfully."
                });

            }
        );

    }
);
// ======================================================
// AI WRITER
// ======================================================

app.post(
    "/api/generate",
    async (req, res) => {

        try {

            const prompt = String(
                req.body.prompt || ""
            ).trim();

            const tone = String(
                req.body.tone || "Professional"
            );

            const length = String(
                req.body.length || "Medium"
            );


            if (!prompt) {

                return res.status(400).json({
                    error: "Prompt is required."
                });

            }


            if (!openaiClient) {

                return res.status(503).json({
                    error:
                        "OpenAI API client is not configured."
                });

            }


            console.log(
                "🤖 Real AI Writer request received"
            );


            const response =
                await openaiClient.responses.create({

                    model: "gpt-5.6-luna",

                    input: `
You are a professional AI writing assistant.

Create the requested content.

Tone:
${tone}

Length:
${length}

User request:
${prompt}
`
                });


            const output =
                response.output_text;


            if (
                !output ||
                !output.trim()
            ) {

                return res.status(500).json({
                    error:
                        "OpenAI returned an empty response."
                });

            }


            saveGeneration(
                req.session.userId,
                "AI Writer"
            );


            console.log(
                "✅ Real AI Writer response generated"
            );


            return res.json({

                output: output,

                mode: "ai"

            });


        } catch (error) {

            console.error(
                "❌ REAL OPENAI ERROR:"
            );

            console.error(
                error
            );


            return res.status(500).json({

                error:
                    error.message ||
                    "OpenAI request failed."

            });

        }

    }
);
// ========================================
// AI IMAGE GENERATOR
// ========================================

app.post("/api/generate-image", async (req, res) => {

    try {

        // Create OpenAI client directly for image generation
        const imageClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });

        const { prompt, style, size } = req.body;

        if (!prompt || !prompt.trim()) {
            return res.status(400).json({
                error: "Image prompt is required."
            });
        }

        if (!process.env.OPENAI_API_KEY) {
            return res.status(503).json({
                error: "OpenAI API key is not configured."
            });
        }

        const finalPrompt = `
Create a high-quality image based on the following description:

${prompt}

Visual style: ${style || "AI Art"}

Make the image detailed, visually appealing and professional.
Do not add text unless the user specifically asks for text.
`;

        console.log("🎨 Generating image...");

        const response = await imageClient.images.generate({
            model: "gpt-image-1",
            prompt: finalPrompt,
            size: size || "1024x1024"
        });

        const imageBase64 = response.data?.[0]?.b64_json;

        if (!imageBase64) {
            return res.status(500).json({
                error: "OpenAI did not return an image."
            });
        }

        console.log("✅ Image generated successfully");

saveGeneration(req.session.userId, "AI Image Generator");

return res.json({
    image: `data:image/png;base64,${imageBase64}`,
    mode: "ai"
});


    } catch (error) {

        console.error("❌ Image Generation Error:", error);

        return res.status(500).json({
            error: error.message || "Image generation failed."
        });

    }

});
// ========================================
// AI CODE GENERATOR
// ========================================

app.post("/api/generate-code", async (req, res) => {

    try {

        if (!process.env.OPENAI_API_KEY) {
            return res.status(503).json({
                error: "OpenAI API key is not configured."
            });
        }

        const codeClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });

        const { prompt, language, level } = req.body;

        if (!prompt || !prompt.trim()) {
            return res.status(400).json({
                error: "Code description is required."
            });
        }

        const selectedLanguage = language || "HTML";
        const selectedLevel = level || "Beginner";

        const instructions = `
You are an expert software developer.

Generate clean, working, ready-to-use code.

Programming language:
${selectedLanguage}

Difficulty level:
${selectedLevel}

User request:
${prompt}

Important rules:
- Return ONLY the code.
- Do not use Markdown code fences.
- Do not add explanations before or after the code.
- Make the code complete and runnable.
- Use clear variable and function names.
- Follow good coding practices.
`;

        console.log("💻 Generating code with AI...");

        const response = await codeClient.responses.create({
            model: "gpt-5.6-luna",
            input: instructions
        });

        const code = response.output_text?.trim();

        if (!code) {
            return res.status(500).json({
                error: "AI did not return any code."
            });
        }

        console.log("✅ Code generated successfully");
        saveGeneration(req.session.userId, "AI Code Generator");

        return res.json({
            code: code,
            mode: "ai"
        });

    } catch (error) {

        console.error("❌ Code Generation Error:", error);

        return res.status(500).json({
            error: error.message || "Code generation failed."
        });

    }

});
// ========================================
// AI EMAIL GENERATOR
// ========================================

app.post("/api/generate-email", async (req, res) => {

    try {

        if (!process.env.OPENAI_API_KEY) {
            return res.status(503).json({
                error: "OpenAI API key is not configured."
            });
        }

        const emailClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });

        const {
            recipient,
            request,
            tone,
            length
        } = req.body;

        if (!recipient || !recipient.trim()) {
            return res.status(400).json({
                error: "Recipient is required."
            });
        }

        if (!request || !request.trim()) {
            return res.status(400).json({
                error: "Email request is required."
            });
        }

        const selectedTone = tone || "Professional";
        const selectedLength = length || "Medium";

        const instructions = `
You are an expert professional email writer.

Write a complete email based on the information below.

Recipient:
${recipient}

User's request:
${request}

Tone:
${selectedTone}

Length:
${selectedLength}

Rules:
- Create a suitable email subject.
- Address the recipient naturally.
- Clearly communicate the user's request.
- Keep the requested tone.
- Keep the requested length.
- End with a suitable professional sign-off.
- Do not explain your process.
- Return ONLY the final email.
`;

        console.log("📧 Generating email with AI...");

        const response = await emailClient.responses.create({
            model: "gpt-5.6-luna",
            input: instructions
        });

        const email = response.output_text?.trim();

        if (!email) {
            return res.status(500).json({
                error: "AI did not return an email."
            });
        }

        console.log("✅ Email generated successfully");
        saveGeneration(req.session.userId, "AI Email Writer");

        return res.json({
            email: email,
            mode: "ai"
        });

    } catch (error) {

        console.error(
            "❌ Email Generation Error:",
            error
        );

        return res.status(500).json({
            error:
                error.message ||
                "Email generation failed."
        });
    }

});
// ========================================
// AI TRANSLATOR
// ========================================

app.post("/api/translate", async (req, res) => {

    try {

        if (!process.env.OPENAI_API_KEY) {
            return res.status(503).json({
                error: "OpenAI API key is not configured."
            });
        }

        const translatorClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });

        const {
            text,
            from,
            to
        } = req.body;

        if (!text || !text.trim()) {
            return res.status(400).json({
                error: "Text is required."
            });
        }

        if (!from || !to) {
            return res.status(400).json({
                error: "Source and target languages are required."
            });
        }

        if (from === to) {
            return res.status(400).json({
                error: "Source and target languages must be different."
            });
        }

        const instructions = `
You are a professional translator.

Translate the following text from ${from} to ${to}.

Important rules:
- Preserve the original meaning.
- Keep the same tone and intent.
- Do not add explanations.
- Do not summarize.
- Do not remove important information.
- Return ONLY the translated text.

Text to translate:

${text}
`;

        console.log(
            `🌐 Translating ${from} → ${to}...`
        );

        const response =
            await translatorClient.responses.create({
                model: "gpt-5.6-luna",
                input: instructions
            });

        const translation =
            response.output_text?.trim();

        if (!translation) {
            return res.status(500).json({
                error: "AI did not return a translation."
            });
        }

        console.log(
            "✅ Translation completed successfully"
        );
        saveGeneration(req.session.userId, "AI Translator");

        return res.json({
            translation: translation,
            mode: "ai"
        });

    } catch (error) {

        console.error(
            "❌ Translation Error:",
            error
        );

        return res.status(500).json({
            error:
                error.message ||
                "Translation failed."
        });
    }

});
// ======================================================
// PDF SUMMARIZER
// ======================================================

app.post(
    "/api/summarize-pdf",
    upload.single("pdf"),
    async (req, res) => {

        try {

            if (!req.file) {

                return res.status(400).json({
                    error:
                        "Please upload a PDF file."
                });

            }


            const parser =
                new PDFParse({
                    data:
                        req.file.buffer
                });


            const result =
                await parser.getText();


            await parser.destroy();


            const extractedText =
                result.text || "";


            if (!extractedText.trim()) {

                return res.status(400).json({
                    error:
                        "Could not extract readable text from this PDF."
                });

            }


            const textForAI =
                extractedText.slice(
                    0,
                    30000
                );


            // Demo mode
            if (!openaiClient) {

                return res.json({

                    filename:
                        req.file.originalname,

                    summary:
`PDF uploaded successfully.

Demo PDF Summary:

${textForAI.slice(0, 4000)}

Real AI summarization will be enabled automatically when a valid OpenAI API key is configured.`,

                    mode: "demo"

                });

            }


            try {

                const response =
                    await openaiClient.responses.create({

                        model: "gpt-5.6-luna",

                        input: `
You are an expert PDF summarization assistant.

Create a clear and accurate summary.

Include:
- Main topic
- Important points
- Key facts
- Important conclusions

Document:
${textForAI}
`

                    });

saveGeneration(req.session.userId, "PDF Summarizer");
                return res.json({

                    filename:
                        req.file.originalname,

                    summary:
                        response.output_text,

                    mode: "ai"

                });


            } catch (aiError) {

                console.error(
                    "⚠️ PDF AI request failed:",
                    aiError.message
                );


                return res.json({

                    filename:
                        req.file.originalname,

                    summary:
`PDF text extracted successfully.

Demo Summary:

${textForAI.slice(0, 4000)}

AI summarization is temporarily unavailable.`,

                    mode: "demo"

                });

            }

        } catch (error) {

            console.error(
                "❌ PDF error:",
                error
            );


            return res.status(500).json({
                error:
                    error.message ||
                    "Failed to process PDF."
            });

        }

    }
);


// ======================================================
// SERVER ERROR HANDLER
// ======================================================

app.use(
    (error, req, res, next) => {

        console.error(
            "❌ Server error:",
            error
        );


        if (
            error.message ===
            "Only PDF files are allowed."
        ) {

            return res.status(400).json({
                error:
                    error.message
            });

        }


        res.status(500).json({
            error:
                "Internal server error."
        });

    }
);
// ======================================================
// DASHBOARD STATS / GENERATION HISTORY
// ======================================================

app.get("/api/dashboard/stats", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            error: "Not logged in."
        });
    }

    const userId = req.session.userId;

    // 1. Total AI generations
    db.get(
        `
        SELECT COUNT(*) AS total
        FROM generations
        WHERE user_id = ?
        `,
        [userId],
        (error, countRow) => {

            if (error) {
                console.error(
                    "❌ Generation count error:",
                    error
                );

                return res.status(500).json({
                    error: "Could not load generation statistics."
                });
            }


            // 2. Number of different tools used
            db.get(
                `
                SELECT COUNT(DISTINCT tool) AS toolsUsed
                FROM generations
                WHERE user_id = ?
                `,
                [userId],
                (error, toolsRow) => {

                    if (error) {
                        console.error(
                            "❌ Tools used count error:",
                            error
                        );

                        return res.status(500).json({
                            error: "Could not load tools used."
                        });
                    }


                    // 3. Recent activity
                    db.all(
                        `
                        SELECT
                            tool,
                            created_at
                        FROM generations
                        WHERE user_id = ?
                        ORDER BY id DESC
                        LIMIT 10
                        `,
                        [userId],
                        (error, rows) => {

                            if (error) {
                                console.error(
                                    "❌ Generation history error:",
                                    error
                                );

                                return res.status(500).json({
                                    error:
                                        "Could not load generation history."
                                });
                            }


                            // 4. Send everything to dashboard
                            res.json({

                                totalGenerations:
                                    countRow.total || 0,

                                toolsUsed:
                                    toolsRow.toolsUsed || 0,

                                recentActivity:
                                    rows || []

                            });

                        }
                    );

                }
            );

        }
    );

})

// ===============================
// AI CODE GENERATOR
// ===============================

app.post("/api/generate-code", async (req, res) => {

    try {

        if (!process.env.OPENAI_API_KEY) {
            return res.status(500).json({
                error: "OpenAI API key is not configured."
            });
        }

        const { prompt, language, level } = req.body;

        if (!prompt || !prompt.trim()) {
            return res.status(400).json({
                error: "Please describe the code you want."
            });
        }

        const codeClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });

        const instructions = `
You are an expert software developer.

Generate clean, working code based on the user's request.

User request:
${prompt}

Programming language:
${language || "HTML"}

Skill level:
${level || "Beginner"}

IMPORTANT RULES:
- Return ONLY the code.
- Do NOT add explanations.
- Do NOT use Markdown code fences.
- Do NOT add "Here is the code".
- Make the code complete and ready to use.
- Follow the requested programming language.
- Keep the code understandable for the selected skill level.
`;

        const response = await codeClient.responses.create({
            model: "gpt-5.6-luna",
            input: instructions
        });

        const code = response.output_text?.trim();

        if (!code) {
            return res.status(500).json({
                error: "AI did not return any code."
            });
        }

        res.json({
            code: code,
            mode: "ai"
        });

    } catch (error) {

        console.error("AI Code Generator Error:", error);

        res.status(500).json({
            error: error.message || "Code generation failed."
        });
    }
});

// ======================================================
// START SERVER
// ======================================================

app.listen(
    port,
    () => {

        console.log("");

        console.log(
            "================================="
        );

        console.log(
            "🚀 AI Toolbox Server Started"
        );

        console.log(
            "================================="
        );

        console.log(
            `🌐 http://localhost:${port}`
        );

        console.log(
            `✍️ AI Writer: http://localhost:${port}/ai-writer.html`
        );

        console.log(
            `📄 PDF Summarizer: http://localhost:${port}/pdf-summarizer.html`
        );

        console.log(
            "================================="
        );

        console.log("");
    }
);