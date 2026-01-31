const { Client } = require('ssh2');

const conn = new Client();
const password = '7512690kirill';

console.log('Connecting to server...');

conn.on('ready', () => {
    console.log('Connected! Setting up server...\n');

    const commands = `
        echo "=== Installing Docker ===" &&
        apt-get update &&
        apt-get install -y ca-certificates curl gnupg &&
        install -m 0755 -d /etc/apt/keyrings &&
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes &&
        chmod a+r /etc/apt/keyrings/docker.gpg &&
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null &&
        apt-get update &&
        apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin &&

        echo "=== Installing Cloudflared ===" &&
        curl -L --output /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb &&
        dpkg -i /tmp/cloudflared.deb &&

        echo "=== Creating project directory ===" &&
        mkdir -p /opt/calories-tracker/mcp_server /opt/calories-tracker/telegram_bot &&

        echo "=== Checking versions ===" &&
        docker --version &&
        docker compose version &&
        cloudflared --version &&

        echo "=== Setup complete! ==="
    `;

    conn.exec(commands, (err, stream) => {
        if (err) {
            console.error('Exec error:', err);
            conn.end();
            return;
        }

        stream.on('close', (code) => {
            console.log('\n' + (code === 0 ? '✅ Server setup complete!' : '⚠️ Setup completed with some warnings'));
            console.log('\nNext: Run deploy-calories-tracker.js');
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
