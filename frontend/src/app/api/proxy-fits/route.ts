// app/api/proxy-fits/route.ts
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get('url');

  if (!targetUrl) {
    return NextResponse.json({ error: 'URL não fornecida' }, { status: 400 });
  }

  try {
    const response = await fetch(targetUrl);
    if (!response.ok) {
      return NextResponse.json({ error: 'Falha ao buscar arquivo na IRSA' }, { status: response.status });
    }

    const buffer = await response.arrayBuffer();

    // Retorna o arquivo FITS passando pelo seu servidor (sem bloqueio de CORS)
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/fits',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('Erro no proxy FITS:', error);
    return NextResponse.json({ error: 'Erro interno no proxy' }, { status: 500 });
  }
}