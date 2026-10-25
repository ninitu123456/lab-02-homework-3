export type ReservationStatus = 'RESERVED' | 'CHECKED_OUT' | 'EXPIRED' | 'CANCELLED';

export interface Product {
  id: string;
  name: string;
  category: string;
  emoji: string;
  color: string;
  price: number;
  originalPrice: number;
  initialStock: number;
  available: number;
}

export interface Reservation {
  id: string;
  productId: string;
  quantity: number;
  status: ReservationStatus;
  expiresAt: number;
  createdAt: number;
  unitPrice: number;
  orderId: string | null;
}

export interface SaleSnapshot {
  serverTime: number;
  startsAt: number;
  endsAt: number;
  products: Product[];
}

export interface ReservationResponse {
  serverTime: number;
  reservation: Reservation;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
