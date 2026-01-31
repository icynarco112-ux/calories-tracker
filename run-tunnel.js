const { Client } = require('ssh2');

const conn = new Client();
const password = '7512690kirill';
const TOKEN = 'eyJhIjoiOWE4NWM2OGUxODQ1ZDQxZTY4MzdjNTNkMDUwMzZkMzEiLCJ0IjoiNWZhYTFlOTctYmY1My00ZjE1LWI5ZDctMzk0YjkzOTQyY2Q5IiwicyI6IlpEY3hZekJtWXpVdE1UbGhaaTAwT0dKbExUZzFOVEV0TjJKbVlqRTVOalJpT0RVeiJ9';

console.log('Installing Cloudflare Tunnel on VPS...\n');

conn.on('ready', () => {
    const commands = `
        # Остановить старый туннель если есть
        pkill cloudflared 2>/dev/null || true

        # Установить как сервис
        cloudflared service install ${TOKEN} 2>&1 || true

        # Запустить сервис
        systemctl enable cloudflared 2>/dev/null || true
        systemctl start cloudflared 2>/dev/null || true

        # Или запустить напрямую в фоне
        nohup cloudflared tunnel run --token ${TOKEN} > /var/log/cloudflared.log 2>&1 &

        sleep 3
        echo "=== Tunnel Status ==="
        ps aux | grep cloudflared | grep -v grep || echo "Checking..."
        echo ""
        echo "=== Recent logs ==="
        tail -10 /var/log/cloudflared.log 2>/dev/null || echo "Starting..."
    `;

    conn.exec(commands, (err, stream) => {
        if (err) {
            console.error('Error:', err);
            conn.end();
            return;
        }

        stream.on('close', () => {
            console.log('\n✅ Tunnel installed!');
            console.log('\nНе забудь настроить Public Hostname в Cloudflare Dashboard:');
            console.log('  - Subdomain: calories (или любой)');
            console.log('  - Domain: выбери свой');
            console.log('  - Service: http://localhost:8787');
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
