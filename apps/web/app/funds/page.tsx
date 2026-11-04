"use client";
import { useApp } from "@/lib/app-context";
import { FundsPanel } from "@/components/account/FundsPanel";
import { Btn, EmptyState, ErrorState, Skeleton } from "@/components/ui/bits";

export default function Funds() {
  const { session, account, accountError, setConnectOpen, refresh } = useApp();
  if (session.kind === "none") return <EmptyState title="Connect to manage funds" action={<Btn onClick={() => setConnectOpen(true)}>Connect wallet</Btn>} />;
  if (accountError) return <ErrorState message={accountError} onRetry={refresh} />;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold md:text-[28px]">Funds</h1>
      {account ? <FundsPanel /> : <Skeleton className="h-64" />}
    </div>
  );
}
