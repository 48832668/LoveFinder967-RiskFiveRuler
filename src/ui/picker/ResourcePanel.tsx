/**
 * 器件选择器右侧的资源栏：选中型号的 Flash / RAM / 主频 / 外设清单。
 */
import type { DeviceDef } from "../../model/types";
import type { ResGroup } from "../../app/resources";

export function ResourcePanel({ dev, groups, isNew }: { dev: DeviceDef | undefined; groups: ResGroup[]; isNew: boolean }) {
  return (
    <div className="res-pane">
      {dev ? (
        <>
          <div className="res-head">
            <b>{dev.id}</b>
            <span>
              {dev.package.label} · {dev.core}
            </span>
          </div>
          <div className="res-scroll">
            {groups.map((g) => (
              <section className="res-group" key={g.title}>
                <h4>{g.title}</h4>
                <table className="res-table">
                  <tbody>
                    {g.rows.map((r) => (
                      <tr key={r.label} className={r.off ? "off" : ""}>
                        <th>{r.label}</th>
                        <td>{r.value}</td>
                        {r.hint && <td className="res-hint">{r.hint}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
        </>
      ) : (
        <div className="res-empty">{isNew ? "选一个型号，再创建工程" : "选一个型号看资源"}</div>
      )}
    </div>
  );
}
