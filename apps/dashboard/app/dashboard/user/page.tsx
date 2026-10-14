import { PageHeader } from '../../components';

function supportUrl(): string | null {
  const configured = process.env.SUPPORT_DISCORD_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === 'https:' && (url.hostname === 'discord.gg' || url.hostname === 'discord.com') ? url.toString() : null;
  } catch { return null; }
}

export default function UserHomePage() {
  const support = supportUrl();
  return <><PageHeader title="Bienvenue sur le panel VeyroBot !" description="Configurez VeyroBot et retrouvez vos réglages personnels dans un espace simple et centralisé." /><section className="surface section-panel user-home-panel"><p>Cliquez sur votre photo de profil pour accéder à votre espace utilisateur, ou sélectionnez l’icône d’un serveur dans la barre latérale pour configurer le bot.</p><p>Les serveurs affichés dépendent de vos permissions Discord. Si un serveur n’apparaît pas, vérifiez que vous disposez des droits nécessaires pour accéder à sa configuration ou y ajouter VeyroBot. Il faut être propriétaire du serveur ou disposer de « Gérer le serveur ».</p><p>Besoin d’aide ? {support ? <a href={support} target="_blank" rel="noopener noreferrer">Contactez notre équipe sur le serveur Discord de support.</a> : 'Contactez notre équipe sur le serveur Discord de support.'}</p></section></>;
}
