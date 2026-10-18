import { User, Country } from '../types';
import { formatPhoneWithCountry } from './countryService';
import { syncUserToFirestore } from './dbService';

const STORAGE_USERS_KEY = 'coca_app_registered_users';
const CURRENT_USER_KEY = 'coca_app_user';

export const INITIAL_USERS: User[] = [
  {
    id: 'usr-super-admin',
    name: 'Super Administrateur',
    phone: '+226 69 44 55 69',
    country: 'BF',
    balance: 0,
    role: 'ADMIN',
    referralCode: 'COCA-SUPERADMIN',
    isBlocked: false,
    password: '@71224956Alas',
    createdAt: new Date().toISOString(),
    totalDeposits: 0,
    totalWithdrawals: 0,
  }
];

export const getStoredUsers = (): User[] => {
  let usersList: User[] = [];
  try {
    const saved = localStorage.getItem(STORAGE_USERS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        usersList = parsed;
      }
    }
  } catch (e) {
    console.error('Error reading users', e);
  }

  // FORCE SYNC: If we have an active user in session, ensure their balance 
  // in the users list matches what is in CURRENT_USER_KEY (which is updated by the server)
  try {
    const currentStr = localStorage.getItem(CURRENT_USER_KEY);
    if (currentStr) {
      const currentUser: User = JSON.parse(currentStr);
      const idx = usersList.findIndex(u => u.id === currentUser.id);
      if (idx !== -1) {
        usersList[idx].balance = currentUser.balance;
      } else {
        usersList.push(currentUser);
      }
    }
  } catch (e) {
    console.error('Error syncing current user balance', e);
  }

  return usersList;
};

export const saveUsers = (users: User[]) => {
  localStorage.setItem(STORAGE_USERS_KEY, JSON.stringify(users));
  // Synchronisation asynchrone non-bloquante avec Firestore pour supporter > 5000 membres
  try {
    users.slice(0, 10).forEach(u => {
      syncUserToFirestore(u).catch(() => {});
    });
  } catch {}
};

export const updateUser = (userId: string, updates: Partial<User>): User[] => {
  const users = getStoredUsers();
  const updated = users.map(u => {
    if (u.id === userId) {
      const newUser = { ...u, ...updates };
      // Check if this is the currently logged in user
      try {
        const currentStr = localStorage.getItem(CURRENT_USER_KEY);
        if (currentStr) {
          const currentUser: User = JSON.parse(currentStr);
          if (currentUser.id === userId || currentUser.phone === u.phone) {
            const mergedCurrent = { ...currentUser, ...updates };
            localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(mergedCurrent));
            window.dispatchEvent(new Event('user_balance_updated'));
          }
        }
      } catch (e) {
        console.error('Error syncing session user', e);
      }
      return newUser;
    }
    return u;
  });

  saveUsers(updated);
  return updated;
};

export const adjustUserBalance = async (
  userId: string, 
  operation: 'ADD' | 'SUBTRACT' | 'SET', 
  amount: number
): Promise<void> => {
  try {
    const token = localStorage.getItem('coca_app_session_token');
    const response = await fetch('/api/user/balance', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}` 
      },
      body: JSON.stringify({ userId, operation, amount })
    });
    
    if (!response.ok) {
        throw new Error('Failed to update balance on server');
    }

    const data = await response.json();
    
    // Optimistic update for local storage to keep UI in sync
    const currentStr = localStorage.getItem(CURRENT_USER_KEY);
    if (currentStr) {
      const currentUser: User = JSON.parse(currentStr);
      if (currentUser.id === userId) {
        currentUser.balance = data.newBalance;
        localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(currentUser));
        window.dispatchEvent(new Event('user_balance_updated'));
      }
    }
  } catch (error) {
    console.error('Error adjusting balance on backend:', error);
    throw error;
  }
};

export const toggleBlockUser = (userId: string): User[] => {
  const users = getStoredUsers();
  const target = users.find(u => u.id === userId);
  if (!target) return users;

  return updateUser(userId, { isBlocked: !target.isBlocked });
};

export const resetUserPassword = (userId: string, newPassword: string): User[] => {
  return updateUser(userId, { password: newPassword });
};

export const createManualUser = (userData: {
  name: string;
  phone: string;
  country: Country;
  balance: number;
  role?: 'USER' | 'ADMIN';
  password?: string;
}): User => {
  const newUser: User = {
    id: 'usr-' + Math.random().toString(36).substring(2, 9),
    name: userData.name,
    phone: userData.phone,
    country: userData.country,
    balance: Math.max(0, userData.balance || 0),
    role: userData.role || 'USER',
    referralCode: 'COCA-' + Math.random().toString(36).substring(2, 6).toUpperCase(),
    isBlocked: false,
    password: userData.password?.trim() || '123456',
    createdAt: new Date().toISOString(),
    totalDeposits: userData.balance || 0,
    totalWithdrawals: 0,
  };

  const users = getStoredUsers();
  const updated = [newUser, ...users];
  saveUsers(updated);
  return newUser;
};

export const normalizePhoneNumber = (raw: string): string => {
  if (!raw) return '';
  return raw.replace(/[\s\-\+\(\)\.]/g, '').replace(/^225|^226/, '');
};

export const findUserByPhone = (phone: string, users?: User[]): User | undefined => {
  const allUsers = users || getStoredUsers();
  const clean = normalizePhoneNumber(phone);
  if (!clean) return undefined;

  // Direct matching for super admin phone 69445569
  if (clean === '69445569' || clean.endsWith('69445569')) {
    const admin = allUsers.find(u => u.id === 'usr-super-admin' || normalizePhoneNumber(u.phone).includes('69445569'));
    if (admin) return admin;
  }
  
  return allUsers.find(u => {
    const uClean = normalizePhoneNumber(u.phone);
    if (uClean === clean) return true;
    if (clean.length >= 6 && uClean.length >= 6) {
      if (uClean.endsWith(clean) || clean.endsWith(uClean)) return true;
    }
    return false;
  });
};

export const registerUser = async (data: {
  name: string;
  phone: string;
  country: Country;
  password: string;
  referralCodeInput?: string;
}): Promise<{ user: User; sessionId: string }> => {
  const cleanName = data.name.trim();
  const cleanPhone = data.phone.trim();
  const cleanPassword = data.password.trim();

  if (!cleanName || cleanName.length < 2) {
    throw new Error("Le nom complet est obligatoire (au moins 2 caractères).");
  }
  if (!cleanPhone || cleanPhone.length < 4) {
    throw new Error("Un numéro de téléphone valide est obligatoire.");
  }
  if (!cleanPassword || cleanPassword.length < 4) {
    throw new Error("Le mot de passe doit comporter au moins 4 caractères.");
  }

  // Appel de l'API serveur pour enregistrement réel et persistance sécurisée
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: cleanName,
        phone: cleanPhone,
        country: data.country,
        password: cleanPassword,
        referralCode: data.referralCodeInput?.trim() || undefined,
      }),
    });

    const body = await res.json();
    if (!res.ok || !body.success) {
      throw new Error(body.error || "Impossible d'enregistrer le compte.");
    }

    const registeredUser: User = body.user;
    const sessionId: string = body.sessionId;

    // Mise en cache locale sécurisée de la session
    localStorage.setItem('coca_app_session_token', sessionId);
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(registeredUser));

    // Synchronisation Firestore pour redondance
    syncUserToFirestore(registeredUser).catch(() => {});

    // Mettre à jour la liste locale
    const currentUsers = getStoredUsers();
    saveUsers([registeredUser, ...currentUsers.filter(u => u.id !== registeredUser.id)]);

    return { user: registeredUser, sessionId };
  } catch (error: any) {
    throw new Error(error.message || "Erreur de connexion lors de l'inscription.");
  }
};

export const authenticateUser = async (
  phone: string, 
  country: Country, 
  password: string
): Promise<{ user?: User; sessionId?: string; error?: string }> => {
  const cleanPhone = phone.trim();
  const cleanPassword = password.trim();

  if (!cleanPhone || cleanPhone.length < 4) {
    return { error: "Veuillez renseigner un numéro de téléphone valide." };
  }
  if (!cleanPassword) {
    return { error: "Veuillez saisir votre mot de passe." };
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: cleanPhone,
        country,
        password: cleanPassword,
      }),
    });

    const body = await res.json();

    if (!res.ok || !body.success) {
      return { error: body.error || "Identifiants invalides." };
    }

    const authenticatedUser: User = body.user;
    const sessionId: string = body.sessionId;

    // Enregistrement du jeton de session backend officiel
    localStorage.setItem('coca_app_session_token', sessionId);
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(authenticatedUser));

    // Mettre à jour la liste locale
    const currentUsers = getStoredUsers();
    saveUsers([authenticatedUser, ...currentUsers.filter(u => u.id !== authenticatedUser.id)]);

    return { user: authenticatedUser, sessionId };
  } catch (error: any) {
    return { error: error.message || "Impossible de joindre le serveur d'authentification." };
  }
};

/**
 * Vérifie la session active auprès du serveur backend
 */
export const verifyServerSession = async (): Promise<User | null> => {
  const token = localStorage.getItem('coca_app_session_token');
  if (!token) {
    localStorage.removeItem(CURRENT_USER_KEY);
    return null;
  }

  try {
    const res = await fetch('/api/auth/me', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success && data.user) {
        localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(data.user));
        return data.user as User;
      }
    }
  } catch (err) {
    console.warn("Session check offline or server restarting:", err);
  }

  // Si le token est invalide ou expiré côté serveur, rejet absolu
  localStorage.removeItem('coca_app_session_token');
  localStorage.removeItem(CURRENT_USER_KEY);
  return null;
};

/**
 * Déconnexion sécurisée : invalidation côté serveur et destruction locale
 */
export const logoutUser = async (): Promise<void> => {
  const token = localStorage.getItem('coca_app_session_token');
  if (token) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch {}
  }
  localStorage.removeItem('coca_app_session_token');
  localStorage.removeItem(CURRENT_USER_KEY);
  sessionStorage.removeItem('coca_app_admin_auth');
};

export const resetPasswordByPhone = (
  phone: string, 
  newPassword: string
): { success: boolean; user?: User; error?: string } => {
  const cleanPassword = newPassword.trim();
  if (!cleanPassword || cleanPassword.length < 4) {
    return { success: false, error: "Le mot de passe doit comporter au moins 4 caractères." };
  }

  const users = getStoredUsers();
  const target = findUserByPhone(phone, users);

  if (!target) {
    return { success: false, error: "Aucun compte trouvé avec ce numéro. Vérifiez votre saisie ou inscrivez-vous." };
  }

  updateUser(target.id, { password: cleanPassword });
  const updatedUsers = getStoredUsers();
  const refreshed = updatedUsers.find(u => u.id === target.id);
  return { success: true, user: refreshed };
};

export const deleteUser = (userId: string): User[] => {
  const users = getStoredUsers().filter(u => u.id !== userId);
  saveUsers(users);
  return users;
};
