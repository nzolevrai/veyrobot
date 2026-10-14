import { REST, Routes } from 'discord.js';
import { warn, actionCommands } from './commands.js';
import { z } from 'zod';

const parsed = z.object({ DISCORD_BOT_TOKEN: z.string().min(1), DISCORD_CLIENT_ID: z.string().min(1), DISCORD_TEST_GUILD_ID: z.string().regex(/^\d{17,20}$/) }).safeParse(process.env);
if (!parsed.success) {
  const missing = [...new Set(parsed.error.issues.map(issue => issue.path.join('.')))];
  console.error(`Déploiement annulé. Variables manquantes ou invalides : ${missing.join(', ')}`);
  process.exit(1);
}
const env = parsed.data;
await new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN).put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_TEST_GUILD_ID), { body: [warn.toJSON(), ...actionCommands.map(command => command.toJSON())] });
console.log(`Commandes de test publiées dans le serveur ${env.DISCORD_TEST_GUILD_ID}. Les commandes globales et des autres serveurs ne sont pas modifiées.`);
