export const ENCODINGS = [
    {
        "instructionId": "sqcvtun_z_mz2",
        "encodingId": "sqcvtun_z_mz2_",
        "mnemonic": "SQCVTUN",
        "className": "SVE2",
        "fileName": "sqcvtun_z_mz2.xml",
        "mask": 4294966304,
        "value": 1160859648,
        "bitCount": 23,
        "fields": [
            {
                "name": "tszh",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "tszl",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 11,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SME2 || FEAT_SVE2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-narrowing-convert"
    }
];
