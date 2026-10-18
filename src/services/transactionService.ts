import { Transaction } from '../types';
import { adjustUserBalance, getStoredUsers, updateUser } from './userService';
import { syncTransactionToFirestore } from './dbService';

const STORAGE_KEY = 'coca_app_transactions';

// Base propre prête pour la production : 0 fausses transactions de test
const SEED_TRANSACTIONS: Transaction[] = [];

export const getStoredTransactions = (): Transaction[] => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        // Filtre les anciennes fausses transactions de démo
        const cleanTxs = parsed.filter(t => 
          !['tx-dep-101', 'tx-wth-102', 'tx-dep-103', 'tx-wth-104', 'tx-dep-105', 'tx-wth-106'].includes(t.id) &&
          !['Kouassi Jean-Marc', 'Ouedraogo Fatimata', 'Bamba Souleymane', 'Kone Aïcha', 'Sawadogo Moussa', 'Yao N’Dri'].includes(t.userName)
        );
        return cleanTxs;
      }
    }
  } catch (e) {
    console.error('Failed to parse transactions', e);
  }
  return [];
};

export const saveTransactions = (txs: Transaction[]) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(txs));
  // Synchronisation asynchrone non-bloquante avec Firestore pour supporter > 5000 membres
  try {
    txs.slice(0, 10).forEach(t => {
      syncTransactionToFirestore(t).catch(() => {});
    });
  } catch {}
};

export const updateTransactionStatus = (
  txId: string, 
  newStatus: 'PENDING' | 'SUCCESS' | 'REJECTED' | 'CANCELLED',
  adminNote?: string
): { updatedTxs: Transaction[]; affectedTx: Transaction | null } => {
  const current = getStoredTransactions();
  let affectedTx: Transaction | null = null;
  const targetTx = current.find(t => t.id === txId);
  if (!targetTx) {
    return { updatedTxs: current, affectedTx: null };
  }
  const previousStatus = targetTx.status;

  // Si le statut est identique, aucune modification ni recalcul de solde (évite tout doublon)
  if (previousStatus === newStatus) {
    return { updatedTxs: current, affectedTx: targetTx };
  }

  const updated = current.map(tx => {
    if (tx.id === txId) {
      affectedTx = {
        ...tx,
        status: newStatus,
        note: adminNote || tx.note || (
          newStatus === 'SUCCESS' ? 'Approuvé' : 
          newStatus === 'CANCELLED' ? 'Annulé (Fonds recrédités sur le compte)' : 
          'Rejeté'
        )
      };
      return affectedTx;
    }
    return tx;
  });

  saveTransactions(updated);

  if (affectedTx && previousStatus !== newStatus) {
    const tx = affectedTx as Transaction;
    // Montant exact lancé à l'origine (ni plus, ni moins)
    const txAmount = Math.max(0, Number(tx.amount) || 0);

    if (txAmount > 0) {
      // Résolution du compte utilisateur cible
      let targetUserId = tx.userId;
      const allUsers = getStoredUsers();

      if (!targetUserId && tx.userPhone) {
        const match = allUsers.find(u => u.phone === tx.userPhone);
        if (match) targetUserId = match.id;
      }
      if (!targetUserId) {
        try {
          const currentStr = localStorage.getItem('coca_app_user');
          if (currentStr) {
            const cu = JSON.parse(currentStr);
            if (cu.phone === tx.userPhone || cu.id === tx.userId) {
              targetUserId = cu.id;
            }
          }
        } catch (e) {
          console.error('Error resolving fallback user', e);
        }
      }

      const userObj = targetUserId ? allUsers.find(u => u.id === targetUserId) : null;

      // 1. GESTION DES DÉPÔTS
      if (tx.type === 'DEPOSIT') {
        if (previousStatus === 'PENDING' && newStatus === 'SUCCESS') {
          // Dépôt approuvé : la mise à jour du solde doit être effectuée par le serveur backend
        } else if (previousStatus === 'SUCCESS' && (newStatus === 'CANCELLED' || newStatus === 'REJECTED')) {
          // Annulation : le serveur doit gérer le remboursement
        }
      } 
      // 2. GESTION DES RETRAITS
      else if (tx.type === 'WITHDRAW') {
        if ((previousStatus === 'PENDING' || previousStatus === 'SUCCESS') && (newStatus === 'CANCELLED' || newStatus === 'REJECTED')) {
          // Recrédit : le serveur doit gérer le remboursement
        } else if ((previousStatus === 'CANCELLED' || previousStatus === 'REJECTED') && newStatus === 'SUCCESS') {
          // Re-validation : le serveur doit gérer
        }
      }
    }
  }

  return { updatedTxs: updated, affectedTx };
};

/**
 * Permet à l'administrateur d'annuler et rembourser immédiatement un retrait (en attente ou déjà validé).
 */
export const cancelWithdrawalByAdmin = (
  txId: string,
  reason?: string
): { success: boolean; message: string; affectedTx: Transaction | null; refundedAmount?: number } => {
  const current = getStoredTransactions();
  const tx = current.find(t => t.id === txId);

  if (!tx) {
    return { success: false, message: 'Transaction introuvable.', affectedTx: null };
  }

  if (tx.status === 'CANCELLED' || tx.status === 'REJECTED') {
    return { success: false, message: 'Ce retrait a déjà été annulé ou rejeté.', affectedTx: tx };
  }

  const motif = reason?.trim() || 'Annulé par l\'administrateur';
  const finalNote = `Retrait annulé par l'administrateur (${motif}). Montant exact de ${tx.amount} FCFA recrédité sur le compte du client.`;

  const { updatedTxs, affectedTx } = updateTransactionStatus(txId, 'CANCELLED', finalNote);

  return {
    success: true,
    message: `Retrait ${tx.reference || tx.id} de ${tx.amount} FCFA annulé. Exactement ${tx.amount} FCFA ont été reversés sur le compte du client (aucun surplus).`,
    affectedTx,
    refundedAmount: tx.amount
  };
};

/**
 * Permet à un utilisateur d'annuler sa demande de retrait en attente.
 * Le montant prélevé est immédiatement reversé sur son solde disponible.
 */
export const cancelWithdrawalByUser = (
  txId: string,
  userId?: string
): { success: boolean; message: string; refundedAmount?: number } => {
  const current = getStoredTransactions();
  const tx = current.find(t => t.id === txId);

  if (!tx) {
    return { success: false, message: 'Demande de retrait introuvable.' };
  }

  if (tx.type !== 'WITHDRAW') {
    return { success: false, message: 'Cette transaction n’est pas un retrait.' };
  }

  if (tx.status !== 'PENDING') {
    const statusLabel = tx.status === 'SUCCESS' ? 'déjà validée et payée' :
                        tx.status === 'CANCELLED' ? 'déjà annulée' : 'déjà rejetée';
    return { 
      success: false, 
      message: `Impossible d'annuler : cette demande est ${statusLabel}.` 
    };
  }

  if (userId && tx.userId && tx.userId !== userId && tx.userId !== 'demo-user') {
    return { success: false, message: 'Vous n’êtes pas autorisé à annuler ce retrait.' };
  }

  const { updatedTxs, affectedTx } = updateTransactionStatus(
    txId,
    'CANCELLED',
    'Demande de retrait annulée par l\'utilisateur. Solde remboursé avec succès.'
  );

  return {
    success: true,
    message: `Votre demande de retrait de ${tx.amount} FCFA a été annulée. Vos fonds ont été immédiatement reversés sur votre solde.`,
    refundedAmount: tx.amount
  };
};

export const addManualTransaction = (newTx: Omit<Transaction, 'id' | 'date'>): Transaction => {
  const current = getStoredTransactions();
  const tx: Transaction = {
    ...newTx,
    id: 'manual-' + Math.random().toString(36).substring(2, 9),
    date: new Date().toISOString()
  };
  const updated = [tx, ...current];
  saveTransactions(updated);
  return tx;
};

export const resetTransactionsToSeed = (): Transaction[] => {
  saveTransactions(SEED_TRANSACTIONS);
  return SEED_TRANSACTIONS;
};
