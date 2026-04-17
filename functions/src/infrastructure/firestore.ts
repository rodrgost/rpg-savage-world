import admin from 'firebase-admin'

// Em Cloud Functions, a inicialização padrão resolve credenciais automaticamente.
if (admin.apps.length === 0) {
  admin.initializeApp()
}

export const firestore = admin.firestore()
export const FieldValue = admin.firestore.FieldValue
