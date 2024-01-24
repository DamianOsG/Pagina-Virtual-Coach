require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const axios = require('axios');
const session = require('express-session');
const cors = require('cors');
const { OpenAI } = require('openai');


const app = express();
app.use(express.json());
app.use(express.static('./'));
app.use(cors()); // Configura CORS si es necesario
app.use(session({
    secret: 'tu_secret_aqui',
    resave: false,
    saveUninitialized: true
}));

const db = new sqlite3.Database('./users.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('Error al conectar con la base de datos SQLite:', err.message);
        process.exit(1);
    }
    console.log('Conectado a la base de datos SQLite.');
    db.run('ALTER TABLE users ADD COLUMN formularioCompletado BOOLEAN DEFAULT FALSE', (alterErr) => {
        if (alterErr && !alterErr.message.includes('duplicate column name')) {
            console.error('Error al modificar la tabla:', alterErr.message);
        }
    });
});

const saltRounds = 10;
app.post('/register', (req, res) => {
    const { name, email, password } = req.body;
    
    // Verificar si la contraseña está presente y no es una cadena vacía.
    if (!password || password.trim() === '') {
        return res.status(400).json({ error: 'password_required' });
    }

    db.get('SELECT email FROM users WHERE email = ?', [email], (err, row) => {
        if (err) {
            console.error('Error al consultar la base de datos:', err);
            return res.status(500).json({ error: 'database_error' });
        }
        
        if (row) {
            return res.status(400).json({ error: 'user_already_exists' });
        }
        
        bcrypt.hash(password, saltRounds, (err, hash) => {
            if (err) {
                console.error('Error al hashear la contraseña:', err);
                return res.status(500).json({ error: 'hashing_failed' });
            }
            
            const sql = 'INSERT INTO users (name, email, password) VALUES (?, ?, ?)';
            db.run(sql, [name, email, hash], (err) => {
                if (err) {
                    console.error('Error al registrar al usuario:', err);
                    return res.status(500).json({ error: 'registration_failed' });
                }
                res.json({ message: 'user_registered' });
            });
        });
    });
});

// Ruta para manejar el inicio de sesión
app.post('/login', (req, res) => {
    const { email, password } = req.body;

    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'database_error' });
        }
        if (!user) {
            return res.status(404).json({ error: 'user_not_found' });
        }

        bcrypt.compare(password, user.password, (err, result) => {
            if (result) {
                // Crear una sesión para el usuario
                req.session.userId = user.id;
                req.session.userName = user.name; // Guardar el nombre del usuario en la sesión
                res.json({ success: true, userName: user.name }); // Devolver el nombre del usuario
            } else {
                res.status(401).json({ error: 'invalid_credentials' });
            }
        });
    });
});

// Mantener la sesion del estado
// En la ruta /session-status
app.get('/session-status', (req, res) => {
    if (req.session.userId) {
        res.json({ loggedIn: true, userId: req.session.userId, userName: req.session.userName });
    } else {
        res.json({ loggedIn: false });
    }
});


// Ruta para obtener la información del usuario
app.get('/user-info/:userId', (req, res) => {
    const userId = req.params.userId;
    db.get('SELECT name, email, formularioCompletado FROM users WHERE id = ?', [userId], (err, row) => {
        if (err) {
            console.error('Error al obtener la información del usuario:', err);
            return res.status(500).send('Error al obtener la información del usuario');
        }
        if (row) {
            res.json({ name: row.name, email: row.email, formularioCompletado: row.formularioCompletado });
        } else {
            res.status(404).send('Usuario no encontrado');
        }
    });
});

// Ruta para cerrar sesión
app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).send('Error al cerrar la sesión');
        }
        res.send('Sesión cerrada con éxito');
    });
});

// CHAT GPT
const openaiClient = new OpenAI(process.env.OPENAI_API_KEY);

app.post('/submit-form', async (req, res) => {
    const { weight, height, carbs, proteins, weightGoal, gender, age } = req.body;
    
    // Validar todos los campos necesarios
    if (!weight || !height || !carbs || !proteins || !weightGoal || !gender || !age ||
        carbs.length === 0 || proteins.length === 0) {
        return res.status(400).json({ error: 'Datos insuficientes' });
    }

    const dietaQuestion = `Con base en estos datos: Peso ${weight}, Altura ${height}, Carbohidratos ${carbs.join(", ")}, Proteínas ${proteins.join(", ")}, Objetivo de peso ${weightGoal}, Género ${gender}, Edad ${age}, ¿cuál sería una dieta adecuada?`;
    const rutinaQuestion = `Con base en estos datos: Peso ${weight}, Altura ${height}, Carbohidratos ${carbs.join(", ")}, Proteínas ${proteins.join(", ")}, Objetivo de peso ${weightGoal}, Género ${gender}, Edad ${age}, ¿cuál sería una rutina de ejercicios adecuada?`;

    try {
        const dietaResponse = await openaiClient.chat.completions.create({
            model: "gpt-3.5-turbo-1106",
            messages: [
              { role: "system", content: "You are a helpful assistant." },
              { role: "user", content: dietaQuestion }
            ]
          });
      
        const rutinaResponse = await openaiClient.chat.completions.create({
        model: "gpt-3.5-turbo-1106",
        messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: rutinaQuestion }
        ]
        });

        // Verificar las respuestas de las APIs
        if (!dietaResponse.data || !dietaResponse.data.choices || !dietaResponse.data.choices.length || !rutinaResponse.data || !rutinaResponse.data.choices || !rutinaResponse.data.choices.length) {
            throw new Error('Respuesta inválida de la API de OpenAI');
        }

        const dieta = dietaResponse.data.choices[0].text;
        const rutina = rutinaResponse.data.choices[0].text;

        const updateDieta = 'UPDATE users SET dieta = ? WHERE id = ?';
        const updateRutina = 'UPDATE users SET rutina = ? WHERE id = ?';

        db.run(updateDieta, [dieta, userId], (err) => {
            if (err) {
                console.error('Error al guardar la dieta:', err);
                return res.status(500).send('Error al guardar la dieta');
            }

            db.run(updateRutina, [rutina, userId], (err) => {
                if (err) {
                    console.error('Error al guardar la rutina:', err);
                    return res.status(500).send('Error al guardar la rutina');
                }
                res.json({ message: 'Plan personalizado creado' });
            });
        });
    }  catch (error) {
        console.error('Error during the form operation:', error);
        res.status(500).send('Internal server error');
      }
    });
    
    // Rutas para obtener dieta y rutina de un usuario específico
    app.get('/dieta/:userId', (req, res) => {
    const userId = req.params.userId;
    db.get('SELECT dieta FROM users WHERE id = ?', [userId], (err, row) => {
    if (err) {
    console.error('Error al consultar la dieta:', err);
    return res.status(500).send('Error al obtener la dieta');
    }
    if (row) {
    res.json({ dieta: row.dieta });
    } else {
    res.status(404).send('Dieta no encontrada');
    }
    });
    });
    
    app.get('/rutina/:userId', (req, res) => {
    const userId = req.params.userId;
    db.get('SELECT rutina FROM users WHERE id = ?', [userId], (err, row) => {
    if (err) {
    console.error('Error al consultar la rutina:', err);
    return res.status(500).send('Error al obtener la rutina');
    }
    if (row) {
    res.json({ rutina: row.rutina });
    } else {
    res.status(404).send('Rutina no encontrada');
    }
    });
    });
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });