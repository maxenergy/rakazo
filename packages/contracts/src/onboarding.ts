import * as z from "zod";
import type { UiLocale } from "./ui-locale.js";

export const OnboardingFocus = z.enum(["day", "inbox", "research", "everything"]);
export type OnboardingFocus = z.infer<typeof OnboardingFocus>;
export const OnboardingApp = z.enum([
  "slack",
  "gmail",
  "googlecalendar",
  "notion",
  "googledocs",
  "hackernews",
]);
export type OnboardingApp = z.infer<typeof OnboardingApp>;

/** Only deterministic product copy carries a reference; model/user text stays literal. */
export const OnboardingText = z.discriminatedUnion("id", [
  z.object({ id: z.literal("focus.ack"), focus: OnboardingFocus }),
  z.object({ id: z.literal("focus.next") }),
  z.object({ id: z.literal("apps.suggest"), names: z.array(z.string()).min(1).max(3) }),
  z.object({ id: z.literal("apps.ready"), count: z.number().int().min(1).max(3) }),
]);
export type OnboardingText = z.infer<typeof OnboardingText>;

type Copy = {
  question: string;
  labels: Record<OnboardingFocus, string>;
  summaries: Record<OnboardingFocus, string>;
  ack: (summary: string) => string;
  next: string;
  suggest: (names: string, count: number) => string;
  ready: (count: number) => string;
  apps: Record<OnboardingApp, string>;
};

export const ONBOARDING_COPY: Record<UiLocale, Copy> = {
  en: {
    question: "What do you want me on first?",
    labels: {
      day: "Day-to-day work",
      inbox: "Inbox & email",
      research: "Research & writing",
      everything: "A bit of everything",
    },
    summaries: {
      day: "Slack, calendar, and email",
      inbox: "Email and calendar",
      research: "The web, notes, and docs",
      everything: "Slack, calendar, and email",
    },
    ack: (summary) =>
      `Got it. ${summary}. I’ll see what’s already connected so I don’t make you set something up twice.`,
    next: "What would you like to work on first?",
    suggest: (names, count) =>
      `${names} ${count === 1 ? "is" : "are"} a good place to start. Connect ${count === 1 ? "it" : "them"} here and I’ll use what you already have.`,
    ready: (count) =>
      count === 1
        ? "Connect it and I’ll start pulling the picture."
        : `Hit those ${count === 2 ? "two" : "three"} and I’ll start pulling the picture.`,
    apps: {
      slack: "Search, read, and send messages.",
      gmail: "Search, read, draft, and send email.",
      googlecalendar: "Search events and schedule meetings.",
      notion: "Search and edit pages and databases.",
      googledocs: "Draft and edit documents.",
      hackernews: "Search stories and discussions.",
    },
  },
  "zh-CN": {
    question: "你想让我先做什么？",
    labels: {
      day: "日常工作",
      inbox: "收件箱和邮件",
      research: "调研和写作",
      everything: "什么都做一点",
    },
    summaries: {
      day: "Slack、日历和邮件",
      inbox: "邮件和日历",
      research: "网页、笔记和文档",
      everything: "Slack、日历和邮件",
    },
    ack: (summary) => `明白了，先处理${summary}。我会先检查已有的连接，避免让你重复设置。`,
    next: "你想先从哪项任务开始？",
    suggest: (names) => `可以先从${names}开始。在这里连接后，我就能使用你已有的内容。`,
    ready: (count) => `连接这 ${count} 个应用后，我就开始整理相关信息。`,
    apps: {
      slack: "搜索、阅读和发送消息。",
      gmail: "搜索、阅读、起草和发送邮件。",
      googlecalendar: "搜索日程和安排会议。",
      notion: "搜索和编辑页面及数据库。",
      googledocs: "起草和编辑文档。",
      hackernews: "搜索文章和讨论。",
    },
  },
  de: {
    question: "Womit soll ich zuerst anfangen?",
    labels: {
      day: "Tägliche Arbeit",
      inbox: "Posteingang & E-Mail",
      research: "Recherche & Schreiben",
      everything: "Ein bisschen von allem",
    },
    summaries: {
      day: "Slack, Kalender und E-Mail",
      inbox: "E-Mail und Kalender",
      research: "Web, Notizen und Dokumente",
      everything: "Slack, Kalender und E-Mail",
    },
    ack: (summary) =>
      `Verstanden: ${summary}. Ich prüfe zuerst die vorhandenen Verbindungen, damit du nichts zweimal einrichten musst.`,
    next: "Woran möchtest du zuerst arbeiten?",
    suggest: (names) =>
      `${names} eignen sich für den Anfang. Verbinde die Apps hier, damit ich deine vorhandenen Inhalte nutzen kann.`,
    ready: (count) =>
      `Verbinde ${count === 1 ? "diese App" : `diese ${count} Apps`}, dann beginne ich, mir einen Überblick zu verschaffen.`,
    apps: {
      slack: "Nachrichten suchen, lesen und senden.",
      gmail: "E-Mails suchen, lesen, entwerfen und senden.",
      googlecalendar: "Termine suchen und Besprechungen planen.",
      notion: "Seiten und Datenbanken suchen und bearbeiten.",
      googledocs: "Dokumente entwerfen und bearbeiten.",
      hackernews: "Beiträge und Diskussionen suchen.",
    },
  },
  es: {
    question: "¿Por dónde quieres que empiece?",
    labels: {
      day: "Trabajo diario",
      inbox: "Bandeja de entrada y correo",
      research: "Investigación y escritura",
      everything: "Un poco de todo",
    },
    summaries: {
      day: "Slack, calendario y correo",
      inbox: "Correo y calendario",
      research: "Web, notas y documentos",
      everything: "Slack, calendario y correo",
    },
    ack: (summary) =>
      `Entendido: ${summary}. Primero comprobaré qué está conectado para que no tengas que configurarlo dos veces.`,
    next: "¿En qué te gustaría trabajar primero?",
    suggest: (names) =>
      `${names} son un buen punto de partida. Conecta las aplicaciones aquí y usaré lo que ya tienes.`,
    ready: (count) =>
      `Conecta ${count === 1 ? "esta aplicación" : `estas ${count} aplicaciones`} y empezaré a reunir la información.`,
    apps: {
      slack: "Buscar, leer y enviar mensajes.",
      gmail: "Buscar, leer, redactar y enviar correos.",
      googlecalendar: "Buscar eventos y programar reuniones.",
      notion: "Buscar y editar páginas y bases de datos.",
      googledocs: "Redactar y editar documentos.",
      hackernews: "Buscar noticias y debates.",
    },
  },
  fr: {
    question: "Par quoi veux-tu que je commence ?",
    labels: {
      day: "Travail quotidien",
      inbox: "Boîte de réception et e-mails",
      research: "Recherche et rédaction",
      everything: "Un peu de tout",
    },
    summaries: {
      day: "Slack, calendrier et e-mails",
      inbox: "E-mails et calendrier",
      research: "Web, notes et documents",
      everything: "Slack, calendrier et e-mails",
    },
    ack: (summary) =>
      `Compris : ${summary}. Je vais vérifier les connexions existantes pour t’éviter une double configuration.`,
    next: "Sur quoi aimerais-tu travailler en premier ?",
    suggest: (names) =>
      `${names} sont un bon point de départ. Connecte les applications ici et j’utiliserai ce que tu as déjà.`,
    ready: (count) =>
      `Connecte ${count === 1 ? "cette application" : `ces ${count} applications`} et je commencerai à rassembler les informations.`,
    apps: {
      slack: "Rechercher, lire et envoyer des messages.",
      gmail: "Rechercher, lire, rédiger et envoyer des e-mails.",
      googlecalendar: "Rechercher des événements et planifier des réunions.",
      notion: "Rechercher et modifier des pages et des bases de données.",
      googledocs: "Rédiger et modifier des documents.",
      hackernews: "Rechercher des articles et des discussions.",
    },
  },
  "pt-BR": {
    question: "Por onde você quer que eu comece?",
    labels: {
      day: "Trabalho do dia a dia",
      inbox: "Caixa de entrada e e-mail",
      research: "Pesquisa e escrita",
      everything: "Um pouco de tudo",
    },
    summaries: {
      day: "Slack, calendário e e-mail",
      inbox: "E-mail e calendário",
      research: "Web, notas e documentos",
      everything: "Slack, calendário e e-mail",
    },
    ack: (summary) =>
      `Entendido: ${summary}. Vou verificar o que já está conectado para você não precisar configurar tudo duas vezes.`,
    next: "No que você gostaria de trabalhar primeiro?",
    suggest: (names) =>
      `${names} são um bom ponto de partida. Conecte os aplicativos aqui e usarei o que você já tem.`,
    ready: (count) =>
      `Conecte ${count === 1 ? "este aplicativo" : `estes ${count} aplicativos`} e começarei a reunir as informações.`,
    apps: {
      slack: "Pesquisar, ler e enviar mensagens.",
      gmail: "Pesquisar, ler, redigir e enviar e-mails.",
      googlecalendar: "Pesquisar eventos e agendar reuniões.",
      notion: "Pesquisar e editar páginas e bancos de dados.",
      googledocs: "Redigir e editar documentos.",
      hackernews: "Pesquisar notícias e discussões.",
    },
  },
  ru: {
    question: "С чего мне начать?",
    labels: {
      day: "Повседневная работа",
      inbox: "Входящие и почта",
      research: "Исследования и тексты",
      everything: "Всего понемногу",
    },
    summaries: {
      day: "Slack, календарь и почта",
      inbox: "Почта и календарь",
      research: "Веб, заметки и документы",
      everything: "Slack, календарь и почта",
    },
    ack: (summary) =>
      `Понятно: ${summary}. Сначала проверю существующие подключения, чтобы не настраивать всё дважды.`,
    next: "Над чем вы хотите поработать сначала?",
    suggest: (names) =>
      `${names} — хорошее начало. Подключите приложения здесь, и я использую то, что у вас уже есть.`,
    ready: (count) =>
      `Подключите ${count === 1 ? "это приложение" : `эти ${count} приложения`}, и я начну собирать информацию.`,
    apps: {
      slack: "Поиск, чтение и отправка сообщений.",
      gmail: "Поиск, чтение, составление и отправка писем.",
      googlecalendar: "Поиск событий и планирование встреч.",
      notion: "Поиск и редактирование страниц и баз данных.",
      googledocs: "Создание и редактирование документов.",
      hackernews: "Поиск статей и обсуждений.",
    },
  },
  tr: {
    question: "Önce neyle ilgilenmemi istersin?",
    labels: {
      day: "Günlük işler",
      inbox: "Gelen kutusu ve e-posta",
      research: "Araştırma ve yazma",
      everything: "Her şeyden biraz",
    },
    summaries: {
      day: "Slack, takvim ve e-posta",
      inbox: "E-posta ve takvim",
      research: "Web, notlar ve belgeler",
      everything: "Slack, takvim ve e-posta",
    },
    ack: (summary) =>
      `Anladım: ${summary}. Aynı kurulumu iki kez yapmaman için önce mevcut bağlantıları kontrol edeceğim.`,
    next: "Önce ne üzerinde çalışmak istersin?",
    suggest: (names) =>
      `${names} iyi bir başlangıç. Uygulamaları burada bağla, ben de mevcut içeriklerini kullanayım.`,
    ready: (count) => `Bu ${count} uygulamayı bağla, ardından bilgileri toplamaya başlayayım.`,
    apps: {
      slack: "Mesajları ara, oku ve gönder.",
      gmail: "E-postaları ara, oku, taslak oluştur ve gönder.",
      googlecalendar: "Etkinlikleri ara ve toplantıları planla.",
      notion: "Sayfaları ve veritabanlarını ara ve düzenle.",
      googledocs: "Belgeler oluştur ve düzenle.",
      hackernews: "Haberleri ve tartışmaları ara.",
    },
  },
  ko: {
    question: "무엇부터 시작할까요?",
    labels: {
      day: "일상 업무",
      inbox: "받은편지함과 이메일",
      research: "조사와 글쓰기",
      everything: "모든 것을 조금씩",
    },
    summaries: {
      day: "Slack, 캘린더와 이메일",
      inbox: "이메일과 캘린더",
      research: "웹, 메모와 문서",
      everything: "Slack, 캘린더와 이메일",
    },
    ack: (summary) =>
      `알겠습니다. ${summary}부터 살펴볼게요. 같은 설정을 반복하지 않도록 기존 연결을 먼저 확인하겠습니다.`,
    next: "어떤 작업부터 시작하고 싶으세요?",
    suggest: (names) =>
      `${names}부터 시작하면 좋겠습니다. 여기서 앱을 연결하면 기존 콘텐츠를 활용할 수 있어요.`,
    ready: (count) => `앱 ${count}개를 연결하면 관련 정보를 정리하기 시작하겠습니다.`,
    apps: {
      slack: "메시지를 검색하고 읽고 보냅니다.",
      gmail: "이메일을 검색하고 읽고 작성하고 보냅니다.",
      googlecalendar: "일정을 검색하고 회의를 예약합니다.",
      notion: "페이지와 데이터베이스를 검색하고 편집합니다.",
      googledocs: "문서를 작성하고 편집합니다.",
      hackernews: "기사와 토론을 검색합니다.",
    },
  },
  hi: {
    question: "आप चाहते हैं कि मैं पहले क्या करूँ?",
    labels: {
      day: "रोज़मर्रा का काम",
      inbox: "इनबॉक्स और ईमेल",
      research: "शोध और लेखन",
      everything: "हर चीज़ का थोड़ा हिस्सा",
    },
    summaries: {
      day: "Slack, कैलेंडर और ईमेल",
      inbox: "ईमेल और कैलेंडर",
      research: "वेब, नोट्स और दस्तावेज़",
      everything: "Slack, कैलेंडर और ईमेल",
    },
    ack: (summary) =>
      `समझ गया: ${summary}। मैं पहले मौजूदा कनेक्शन देखूँगा, ताकि आपको दोबारा सेटअप न करना पड़े।`,
    next: "आप पहले किस काम से शुरुआत करना चाहेंगे?",
    suggest: (names) =>
      `${names} से शुरुआत कर सकते हैं। ऐप यहाँ कनेक्ट करें, ताकि मैं आपकी मौजूदा सामग्री इस्तेमाल कर सकूँ।`,
    ready: (count) => `ये ${count} ऐप कनेक्ट करें, फिर मैं संबंधित जानकारी जुटाना शुरू करूँगा।`,
    apps: {
      slack: "संदेश खोजें, पढ़ें और भेजें।",
      gmail: "ईमेल खोजें, पढ़ें, लिखें और भेजें।",
      googlecalendar: "कार्यक्रम खोजें और बैठकें तय करें।",
      notion: "पेज और डेटाबेस खोजें और संपादित करें।",
      googledocs: "दस्तावेज़ लिखें और संपादित करें।",
      hackernews: "लेख और चर्चाएँ खोजें।",
    },
  },
};

export function onboardingText(reference: OnboardingText, locale: UiLocale): string {
  const copy = ONBOARDING_COPY[locale];
  switch (reference.id) {
    case "focus.ack":
      return copy.ack(copy.summaries[reference.focus]);
    case "focus.next":
      return copy.next;
    case "apps.suggest":
      return copy.suggest(
        new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(reference.names),
        reference.names.length,
      );
    case "apps.ready":
      return copy.ready(reference.count);
  }
}
