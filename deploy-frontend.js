const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();
const password = '7512690kirill';

console.log('Connecting to production server...');

conn.on('ready', () => {
    console.log('Connected! Deploying frontend...');

    conn.sftp((err, sftp) => {
        if (err) {
            console.error('SFTP error:', err);
            conn.end();
            return;
        }

        const localDistPath = path.join(__dirname, 'Новый ЮИ без привязок к АПИ', 'dist');
        const remotePath = '/var/www/talkytimes-dashboard';

        // Read dist directory
        const files = [];

        function readDirRecursive(dir, base = '') {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const relativePath = base ? `${base}/${item}` : item;
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    files.push({ type: 'dir', path: relativePath });
                    readDirRecursive(fullPath, relativePath);
                } else {
                    files.push({ type: 'file', path: relativePath, local: fullPath });
                }
            }
        }

        readDirRecursive(localDistPath);

        let uploaded = 0;
        const total = files.filter(f => f.type === 'file').length;

        function uploadNext(index) {
            if (index >= files.length) {
                console.log(`\nDeployed ${uploaded} files successfully!`);
                console.log('Reloading nginx...');
                conn.exec('nginx -t && systemctl reload nginx', (err, stream) => {
                    if (err) {
                        console.error('Nginx reload error:', err);
                    }
                    stream.on('close', (code) => {
                        console.log(code === 0 ? 'Nginx reloaded!' : 'Nginx reload failed');
                        conn.end();
                    }).on('data', (data) => {
                        console.log(data.toString());
                    }).stderr.on('data', (data) => {
                        console.log(data.toString());
                    });
                });
                return;
            }

            const file = files[index];
            const remoteFull = `${remotePath}/${file.path}`;

            if (file.type === 'dir') {
                sftp.mkdir(remoteFull, (err) => {
                    // Ignore if exists
                    uploadNext(index + 1);
                });
            } else {
                sftp.fastPut(file.local, remoteFull, (err) => {
                    if (err) {
                        console.error(`Error uploading ${file.path}:`, err.message);
                    } else {
                        uploaded++;
                        process.stdout.write(`\rUploading: ${uploaded}/${total} files`);
                    }
                    uploadNext(index + 1);
                });
            }
        }

        uploadNext(0);
    });
}).on('error', (err) => {
    console.error('Connection error:', err);
}).connect({
    host: '89.117.48.224',
    port: 22,
    username: 'root',
    password: password
});
