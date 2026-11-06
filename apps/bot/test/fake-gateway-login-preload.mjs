import { Client } from 'discord.js';

Client.prototype.login = async function fakeGatewayLogin() {
  process.stdout.write('FAKE_GATEWAY_LOGIN_REACHED\n');
  process.exit(42);
};
