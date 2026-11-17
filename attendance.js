/**
 * SMART WEBRTC CLASSROOM - Attendance Management Engine
 * Real-time student attendance tracking, roll-number verification,
 * and RFC-4180 CSV spreadsheet export for academic record keeping.
 */

class AttendanceManager {
  constructor() {
    this.records = new Map(); // studentId -> { id, name, rollNo, joinTime, status }
  }

  recordStudent(student, status = 'Present') {
    if (!student || !student.id) return null;
    const existing = this.records.get(student.id);
    const joinTimestamp = existing && existing.joinTimestamp ? existing.joinTimestamp : (student.joinedAt || Date.now());
    const joinTime = existing
      ? existing.joinTime
      : new Date(joinTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const rec = {
      id: student.id,
      name: student.name || 'Student',
      rollNo: student.rollNo || (student.clientInfo && student.clientInfo.rollNo) || 'N/A',
      joinTime: joinTime,
      joinTimestamp: joinTimestamp,
      status: status
    };
    this.records.set(student.id, rec);
    return rec;
  }

  getPresentCount() {
    let count = 0;
    this.records.forEach((rec) => {
      if (rec.status === 'Present') count++;
    });
    return count;
  }

  exportCSV(roomCode = 'Classroom') {
    const rows = [['Serial No', 'Student Name', 'Roll Number', 'Join Time', 'Status']];
    // Chronological sequence using the last 2 digits of the roll number
    const sorted = Array.from(this.records.values()).sort((a, b) => {
      const extractDigits = (r, n) => {
        const candidates = [r, n];
        for (const str of candidates) {
          if (!str || typeof str !== 'string') continue;
          const match = str.match(/\d+/g);
          if (match && match.length > 0) {
            const lastNumStr = match[match.length - 1];
            const last2 = lastNumStr.length > 2 ? lastNumStr.slice(-2) : lastNumStr;
            const parsed = parseInt(last2, 10);
            if (!isNaN(parsed)) return parsed;
          }
        }
        return null;
      };
      const numA = extractDigits(a.rollNo, a.name);
      const numB = extractDigits(b.rollNo, b.name);
      if (numA !== null && numB !== null) {
        if (numA !== numB) return numA - numB;
      } else if (numA !== null) {
        return -1;
      } else if (numB !== null) {
        return 1;
      }
      return (a.joinTimestamp || 0) - (b.joinTimestamp || 0);
    });
    sorted.forEach((rec, idx) => {
      rows.push([
        idx + 1,
        `"${(rec.name || '').replace(/"/g, '""')}"`,
        `"${(rec.rollNo || 'N/A').replace(/"/g, '""')}"`,
        `"${(rec.joinTime || '').replace(/"/g, '""')}"`,
        `"${(rec.status || 'Present').replace(/"/g, '""')}"`
      ]);
    });

    const csvContent = rows.map((r) => r.join(',')).join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Amrita_Attendance_Room_${roomCode}_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 500);
  }
}

window.AttendanceManager = AttendanceManager;