'use client';

import { PageHeader } from '../../../components';
import { useUserProfile } from '../user-space';

export default function ProfilePage() {
  const user = useUserProfile();
  return <><PageHeader title="Profil" description="Informations du compte Discord actuellement connecté." /><section className="surface section-panel user-home-panel"><h2>Compte Discord</h2><dl className="profile-details"><div><dt>Nom d’utilisateur</dt><dd>{user?.username ?? 'Chargement…'}</dd></div><div><dt>Identifiant Discord</dt><dd>{user?.id ?? '—'}</dd></div></dl><p>Le nom et la photo de profil se modifient dans Discord. Aucun réglage de profil VeyroBot supplémentaire n’est disponible actuellement.</p></section></>;
}
