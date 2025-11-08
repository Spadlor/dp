const config = require('./settings.js');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    useMultiFileAuthState 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const chalk = require('chalk');
const path = require('path');
const Jimp = require('jimp');
const readline = require('readline');
const NodeCache = require('node-cache');

const msgRetryCounterCache = new NodeCache();

const rlInterface = {
    output: process.stdout,
    input: process.stdin
};

const rl = readline.createInterface(rlInterface);

const question = prompt => new Promise(resolve => {
    if (rl.closed) resolve('');
    else rl.question(prompt, resolve);
});

let store = null;
global.phoneNumber = null;
global.countryCode = null;

module.exports = async function startBot() {
    try {
        if (!config.authMethod || !config.sessionFile) {
            console.log('Invalid config in settings.js!');
            process.exit(1);
        }

        const isPairing = config.authMethod.toLowerCase() === 'pairing';
        const isQR = config.authMethod.toLowerCase() === 'qr';

        if (isPairing && !global.phoneNumber) {
            for (let attempt = 0; attempt < 3; attempt++) {
                let countryCodeInput = await question(chalk.yellowBright('Enter your country code (e.g., 91 for India): '));
                countryCodeInput = countryCodeInput.trim().replace(/\D/g, '');
                
                if (!countryCodeInput || countryCodeInput.length < 1 || countryCodeInput.length > 4) {
                    console.log(chalk.redBright('Invalid country code! Try again.'));
                    continue;
                }
                
                global.countryCode = countryCodeInput;

                let phoneInput = await question(chalk.yellowBright('Enter your phone number (without country code): '));
                phoneInput = phoneInput.trim().replace(/\D/g, '');
                
                if (!phoneInput || phoneInput.length < 6 || phoneInput.length > 15) {
                    console.log(chalk.redBright('Invalid phone number! Try again.'));
                    continue;
                }
                
                global.phoneNumber = '+' + countryCodeInput + phoneInput;
                console.log(chalk.cyan(''));
                break;
            }

            if (!global.phoneNumber) {
                console.log(chalk.redBright('Tried 3 times, exiting!'));
                process.exit(1);
            }

            if (!rl.closed) rl.close();
        }

        const { state: authState, saveCreds } = await useMultiFileAuthState(config.sessionFile);
        
        const loggerConfig = { level: 'silent' };
        store = makeCacheableSignalKeyStore(authState.creds, pino(loggerConfig));

        const { version: waVersion, isLatest } = await fetchLatestBaileysVersion();
        console.log('Using WhatsApp v' + waVersion.join('.') + ', isLatest: ' + isLatest);

        const connectionConfig = { level: 'silent' };

        const authConfig = {
            creds: authState.creds,
            keys: store
        };

        const sock = makeWASocket({
            version: waVersion,
            logger: pino(connectionConfig),
            auth: authConfig,
            patchMessageBeforeSending: message => message,
            msgRetryCounterCache: msgRetryCounterCache
        });

        sock.ev.on('creds.update', saveCreds);

        if (isPairing && !sock.authState.creds.registered) {
            const cleanNumber = global.phoneNumber.replace(/[^0-9]/g, '');
            
            setTimeout(async () => {
                const pairingCode = await sock.requestPairingCode(cleanNumber);
                const formattedCode = pairingCode.match(/.{1,4}/g)?.join('-') || pairingCode;
                console.log(chalk.greenBright('Your pairing code: '), formattedCode);
            }, 3000);
        }

        if (isQR) {
            sock.ev.on('connection.update', async update => {
                const { qr } = update;
                if (qr) console.log(chalk.green('Scan this QR code in WhatsApp: ' + qr));
            });
        }

        sock.ev.on('connection.update', async update => {
            const { connection: connStatus, lastDisconnect: disconnect } = update;
            
            if (connStatus === 'close') {
                const statusCode = disconnect?.error?.output?.statusCode || 0;
                const retryCodes = [
                    DisconnectReason.connectionClosed,
                    DisconnectReason.connectionLost,
                    DisconnectReason.connectionLost,
                    DisconnectReason.timedOut,
                    515
                ];
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('Device logged out. Cleaning session...');
                    await cleanSessionFiles();
                    process.exit(1);
                } else if (statusCode === DisconnectReason.restartRequired) {
                    console.log('New session opened elsewhere. Close it first!');
                    await cleanSessionFiles();
                    process.exit(1);
                } else if (statusCode === DisconnectReason.badSession) {
                    console.log('Session corrupted, delete and re-authenticate!');
                    await cleanSessionFiles();
                    global.phoneNumber = null;
                    process.exit(1);
                } else if (retryCodes.includes(statusCode)) {
                    console.log('Connection closed, retrying...');
                    setTimeout(() => startBot(), 5000);
                } else {
                    console.log('Unknown error: ' + statusCode);
                    process.exit(1);
                }
            } else if (connStatus === 'open') {
                const userName = sock.user.name || config.BotName || 'Bot';
                const userNumber = sock.user.id.split(':')[0];
                
                console.log('==========================');
                console.log(chalk.yellowBright('• User Info'));
                console.log(chalk.cyan('- Name: ' + userName));
                console.log(chalk.yellowBright('- Number: ' + userNumber));
                console.log(chalk.yellowBright('- Status: Connected'));
                console.log('==========================');
                
                try {
                    const message = {
                        text: 'Thanks for using this bot!\nHave a great day!\nㅤㅤㅤㅤㅤㅤㅤㅤㅤ~ Aeon'
                    };
                    await sock.sendMessage(userNumber + '@s.whatsapp.net', message);
                } catch (error) {
                    console.error('Failed to send self-message:', error);
                }
                
                await setProfilePicture(sock);
                console.log(chalk.greenBright('Profile picture set successfully!'));
                await sock.logout();
                console.log(chalk.green('Logged out successfully!'));
                await cleanSessionFiles();
                console.log(chalk.greenBright('Done! Exiting now...'));
                process.exit(0);
            }
        });

    } catch (error) {
        console.error('Something went wrong:', error);
        if (!rl.closed) rl.close();
        process.exit(1);
    }
};

async function setProfilePicture(sock) {
    try {
        const profileFolder = './profile';
        if (!fs.existsSync(profileFolder)) {
            console.error('Profile folder not found!');
            process.exit(1);
        }

        const files = fs.readdirSync(profileFolder);
        const imageFiles = files.filter(file => 
            ['.jpg', '.jpeg', '.png'].includes(path.extname(file).toLowerCase())
        );
        
        if (imageFiles.length === 0) {
            console.error('No images found in profile folder!');
            process.exit(1);
        }

        const imagePath = path.join(profileFolder, imageFiles[0]);
        console.log(chalk.greenBright('Profile picture selected: ' + imageFiles[0]));

        const image = await Jimp.read(imagePath);
        const croppedImage = image.crop(0, 0, image.getWidth(), image.getHeight());
        const resizedImage = await croppedImage.scaleToFit(720, 720);
        const buffer = await resizedImage.getBuffer(Jimp.MIME_JPEG);

        const messageAttrs = {
            to: 's.whatsapp.net',
            type: 'set',
            xmlns: 'w:profile:picture'
        };

        const pictureAttrs = {
            type: 'image'
        };

        const pictureContent = {
            tag: 'picture',
            attrs: pictureAttrs,
            content: buffer
        };

        const iqMessage = {
            tag: 'iq',
            attrs: messageAttrs,
            content: [pictureContent]
        };
        
        await sock.query(iqMessage);

    } catch (error) {
        console.error('Error setting profile picture:', error);
    }
}

async function cleanSessionFiles() {
    try {
        if (fs.existsSync('./Session')) {
            const options = {
                recursive: true,
                force: true
            };
            fs.rmSync('./Session', options);
            console.log(chalk.greenBright('Session folder deleted successfully!'));
        }
    } catch (error) {
        console.error('Error cleaning session files:', error);
    }
}
