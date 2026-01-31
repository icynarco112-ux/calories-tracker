const { Client } = require('ssh2');

const conn = new Client();
const password = '7512690kirill';

console.log('Connecting to server...');

conn.on('ready', () => {
    console.log('Connected! Starting containers...\n');

    const commands = `
        cd /opt/calories-tracker &&
        docker compose down 2>/dev/null || true &&
        docker compose build --no-cache &&
        docker compose up -d &&
        sleep 5 &&
        docker compose ps &&
        docker compose logs --tail=20
    `;

    conn.exec(commands, (err, stream) => {
        if (err) {
            console.error('Exec error:', err);
            conn.end();
            return;
        }

        stream.on('close', (code) => {
            console.log('\n' + (code === 0 ? '✅ Containers started!' : '⚠️ Completed with warnings'));
            conn.end();
        }).on('data', (data) => {
            process.stdout.write(data.toString());
        }).stderr.on('data', (data) => {
            process.stdout.write(data.toString());
        });
    });
}).on('error', (err) => {
    console.error('Connection error:', err);
}).connect({
    host: '89.117.48.224',
    port: 22,
    username: 'root',
    password: password
});
