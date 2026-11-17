// Invariants de src/bot.js vérifiés sur le source (le bot lui-même a besoin
// de Discord et de StashDB pour démarrer).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const bot = fs.readFileSync(path.join(root, 'src', 'bot.js'), 'utf8');

/** Corps d'une fonction, de sa déclaration à l'accolade correspondante. */
function body(start) {
  const i = bot.indexOf(start);
  if (i === -1) return '';
  let depth = 0;
  for (let k = bot.indexOf('{', i); k < bot.length; k++) {
    if (bot[k] === '{') depth++;
    else if (bot[k] === '}' && --depth === 0) return bot.slice(i, k + 1);
  }
  return bot.slice(i);
}

describe('src/bot.js', () => {
  it('sendToChannel rend « sent » seulement après un envoi réussi, et vérifie NSFW', () => {
    const b = body('async function sendToChannel(');
    expect(b.indexOf('await channel.send(')).toBeGreaterThan(-1);
    expect(b.indexOf('await channel.send(')).toBeLessThan(b.indexOf("return 'sent';"));
    expect(b).toContain("let outcome = 'failed';");
    expect(b).toContain('channel.nsfw');
  });

  it('les annonces passent par le journal des envois (aucun doublon par salon)', () => {
    expect(bot).toMatch(/createDeliverer\(\{\s*store,/);
    const d = body('async function deliver(');
    expect(d).toContain('deliverOnce(');
    expect(d).not.toContain('sendToChannel(');
  });

  it('commande réservée aux gestionnaires, déclarée et vérifiée à l’exécution', () => {
    expect(bot).toContain('.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)');
    expect(bot).toContain('.setDMPermission(false)');
    expect(bot).toMatch(/memberPermissions\?\.has\(PermissionFlagsBits\.ManageGuild\)/);
    expect(bot).toContain('isGuildAllowed(interaction.guildId)');
  });

  it('aucune mention ne peut partir', () => {
    expect(bot).toMatch(/new Client\(\{[\s\S]*allowedMentions: \{ parse: \[\] \}/);
    expect(bot).not.toMatch(/parse: \[[^\]]/);
  });

  it('les réponses de commande sont éphémères', () => {
    expect(bot).toMatch(/const ephemeral = [^\n]*MessageFlags\.Ephemeral/);
    expect(bot).toContain('deferReply({ flags: MessageFlags.Ephemeral })');
  });

  it('le répertoire de données est créé avant l’ouverture de la base', () => {
    expect(bot.indexOf('mkdirSync(BOT_DATA_DIR')).toBeGreaterThan(-1);
    expect(bot.indexOf('mkdirSync(BOT_DATA_DIR')).toBeLessThan(bot.indexOf('new Database('));
  });

  it('l’image Docker embarque tout le code', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY src ./src');
    expect(dockerfile).not.toContain('.env');
  });

  it('docker-compose.yml lance l’image publiée, durcie, sans secret', () => {
    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/^\s*image: ghcr\.io\/[\w-]+\/stashdb-release-bot:latest$/m);
    expect(compose).not.toMatch(/^\s*build:/m);
    expect(compose).toContain('env_file: .env');
    expect(compose).toContain('bot-data:/data');
    expect(compose).toContain('read_only: true');
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose).not.toMatch(/^\s*(DISCORD_TOKEN|STASH_API_KEY|CLIENT_ID)\s*:/m);
  });

  it('l’image n’est publiée qu’après des tests verts', () => {
    const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'docker.yml'), 'utf8');
    expect(wf).toMatch(/needs: test/);
    expect(wf).toContain('secrets.GITHUB_TOKEN');
    expect(wf).toContain('linux/amd64,linux/arm64');
  });
});
